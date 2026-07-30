import type { UsageSnapshot, UsageSummary } from "@ambient/shared/usage";
import { AuthServerRequestError, AuthServerTimeoutError, AuthServerUsageError } from "../auth/server-client.js";
import type { SignedInWorkOsSession } from "../workos/session.js";
import { sessionUsageOwnerKey } from "./availability.js";

interface CachedUsage {
  readonly ownerKey: string;
  readonly summary: UsageSummary;
  readonly fetchedAtMs: number;
}

export class BridgeUsageCache {
  #cached: CachedUsage | null = null;
  #inFlight: Promise<UsageSnapshot> | null = null;
  #activeOwnerKey: string | null = null;
  #generation = 0;

  constructor(
    private readonly freshTtlMs = 30_000,
    private readonly nowMs: () => number = Date.now,
  ) {}

  read(input: {
    readonly session: SignedInWorkOsSession | null;
    readonly force?: boolean;
    readonly load: (session: SignedInWorkOsSession) => Promise<UsageSummary>;
  }): Promise<UsageSnapshot> {
    if (!input.session) {
      this.clear();
      return Promise.resolve({ state: "unavailable", reason: "signed_out" });
    }
    const ownerKey = sessionUsageOwnerKey(input.session);
    if (this.#activeOwnerKey !== ownerKey) {
      this.clear();
      this.#activeOwnerKey = ownerKey;
    }
    const nowMs = this.nowMs();
    if (!input.force && this.#cached && nowMs - this.#cached.fetchedAtMs < this.freshTtlMs) {
      return Promise.resolve(snapshot("ready", this.#cached));
    }
    if (this.#inFlight) return this.#inFlight;
    const generation = this.#generation;
    const inFlight = this.#load(input.session, ownerKey, generation, input.load).finally(() => {
      if (this.#inFlight === inFlight) this.#inFlight = null;
    });
    this.#inFlight = inFlight;
    return inFlight;
  }

  observe(summary: UsageSummary, fetchedAtMs = this.nowMs()): void {
    const ownerKey = `${summary.owner.kind}:${summary.owner.id}`;
    if (this.#activeOwnerKey !== ownerKey) {
      this.clear();
      this.#activeOwnerKey = ownerKey;
    }
    this.#cached = { ownerKey, summary, fetchedAtMs };
  }

  clear(): void {
    this.#cached = null;
    this.#inFlight = null;
    this.#activeOwnerKey = null;
    this.#generation += 1;
  }

  async #load(
    session: SignedInWorkOsSession,
    expectedOwnerKey: string,
    generation: number,
    load: (session: SignedInWorkOsSession) => Promise<UsageSummary>,
  ): Promise<UsageSnapshot> {
    try {
      const summary = await load(session);
      if (`${summary.owner.kind}:${summary.owner.id}` !== expectedOwnerKey) {
        throw new Error("Usage summary owner did not match the active session.");
      }
      if (generation !== this.#generation || this.#activeOwnerKey !== expectedOwnerKey) {
        return { state: "unavailable", reason: "server_error" };
      }
      this.observe(summary);
      return snapshot("ready", this.#cached!);
    } catch (error) {
      if (this.#cached?.ownerKey === expectedOwnerKey) return snapshot("stale", this.#cached);
      return { state: "unavailable", reason: unavailableReason(error) };
    }
  }
}

function snapshot(state: "ready" | "stale", cached: CachedUsage): UsageSnapshot {
  return { state, summary: cached.summary, fetchedAt: new Date(cached.fetchedAtMs).toISOString() };
}

function unavailableReason(error: unknown): Extract<UsageSnapshot, { state: "unavailable" }>["reason"] {
  if (error instanceof AuthServerRequestError && error.status === 401) return "signed_out";
  if (error instanceof AuthServerUsageError && error.status === 401) return "signed_out";
  if (error instanceof AuthServerUsageError
    && error.code === "USAGE_UNAVAILABLE"
    && error.status === 503) return "not_enabled";
  if (error instanceof AuthServerTimeoutError || error instanceof TypeError) return "offline";
  return "server_error";
}
