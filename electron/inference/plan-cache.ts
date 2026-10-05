import { inferencePlanSchema, type InferencePlan } from "@alexandria/cloud-contract/inference-catalog";
import type { InferencePlanFetchResult } from "../auth/server-client.js";
import type { SignedInWorkOsSession } from "../workos/session.js";

/**
 * Bridge copy of the account's inference plan (`GET /v1/inference/plan`,
 * ADR-0297): the models each job may use, its default, fallbacks and
 * visibility, resolved by Cloud from the catalog and the org policy.
 *
 * One entry for the signed-in account (WorkOS user in its active
 * organization). A fresh answer is reused for `freshMs`; If-None-Match keeps
 * refreshes cheap; a failed refresh keeps the last good plan (`stale`). A
 * Cloud released before the plan answers 404: the method then returns null
 * and the app keeps the `/inference/models` assignment. The entry is dropped
 * on sign-out and whenever the account changes; a plan is never served to
 * another account.
 */

export type BridgeInferencePlanSnapshot = {
  /** `stale`: the last refresh failed; this is the last good plan for the account. */
  readonly state: "ready" | "stale";
  readonly plan: InferencePlan;
  /** ISO time of the last successful Cloud answer (200 or 304). */
  readonly fetchedAt: string;
  /** Account the plan was resolved for; the app ignores it for any other. */
  readonly evaluatedFor: { readonly userId: string; readonly organizationId: string | null };
};

export type BridgeInferencePlanCacheOptions = {
  readonly fetch: (sessionToken: string, etag: string | null) => Promise<InferencePlanFetchResult>;
  readonly nowMs?: () => number;
  /** A successful answer (plan or 404) younger than this is reused unless forced. */
  readonly freshMs?: number;
  /** Unforced retries after a failure wait at least this long. */
  readonly retryMs?: number;
  /** Failed refreshes (network, invalid body); never carries plan contents. */
  readonly onError?: (error: unknown) => void;
};

type Entry = {
  readonly ownerKey: string;
  readonly evaluatedFor: BridgeInferencePlanSnapshot["evaluatedFor"];
  plan: InferencePlan | null;
  etag: string | null;
  /** Last successful answer; a 404 (Cloud predates the plan) counts and leaves `plan` null. */
  fetchedAtMs: number | null;
  failedAtMs: number | null;
};

/** The plan belongs to one WorkOS user in one organization (or their personal workspace). */
export function inferencePlanOwnerKey(session: Pick<SignedInWorkOsSession, "user" | "organizationId">): string {
  return `${session.user.id}:${session.organizationId?.trim() || "personal"}`;
}

export class BridgeInferencePlanCache {
  #entry: Entry | null = null;
  #generation = 0;
  #inFlight: { readonly ownerKey: string; readonly generation: number; readonly promise: Promise<BridgeInferencePlanSnapshot | null> } | null = null;
  readonly #options: BridgeInferencePlanCacheOptions;
  readonly #nowMs: () => number;
  readonly #freshMs: number;
  readonly #retryMs: number;

  constructor(options: BridgeInferencePlanCacheOptions) {
    this.#options = options;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#freshMs = options.freshMs ?? 60_000;
    this.#retryMs = options.retryMs ?? 15_000;
  }

  /** Drops the account's plan (sign-out, account or organization switch). */
  clear(): void {
    this.#generation += 1;
    this.#entry = null;
    this.#inFlight = null;
  }

  /** The account's plan, or null when signed out, when Cloud has none (404), or when none was ever fetched. */
  read(session: SignedInWorkOsSession | null, options: { readonly force?: boolean } = {}): Promise<BridgeInferencePlanSnapshot | null> {
    if (!session) {
      if (this.#entry) this.clear();
      return Promise.resolve(null);
    }
    const ownerKey = inferencePlanOwnerKey(session);
    if (this.#entry?.ownerKey !== ownerKey) {
      this.clear();
      this.#entry = {
        ownerKey,
        evaluatedFor: { userId: session.user.id, organizationId: session.organizationId?.trim() || null },
        plan: null,
        etag: null,
        fetchedAtMs: null,
        failedAtMs: null,
      };
    }
    const entry = this.#entry!;
    const now = this.#nowMs();
    const fresh = entry.failedAtMs === null && entry.fetchedAtMs !== null && now - entry.fetchedAtMs < this.#freshMs;
    const backingOff = entry.failedAtMs !== null && now - entry.failedAtMs < this.#retryMs;
    if (!options.force && (fresh || backingOff)) return Promise.resolve(this.#snapshot(entry));
    if (this.#inFlight?.ownerKey === ownerKey && this.#inFlight.generation === this.#generation) return this.#inFlight.promise;
    const generation = this.#generation;
    const promise = this.#load(entry, session.sessionToken, generation).finally(() => {
      if (this.#inFlight?.promise === promise) this.#inFlight = null;
    });
    this.#inFlight = { ownerKey, generation, promise };
    return promise;
  }

  async #load(entry: Entry, sessionToken: string, generation: number): Promise<BridgeInferencePlanSnapshot | null> {
    // Only revalidate a plan we hold; a 304 without one would leave nothing to serve.
    const etag = entry.plan ? entry.etag : null;
    try {
      const result = await this.#options.fetch(sessionToken, etag);
      if (!this.#current(entry, generation)) return null;
      if (result.kind === "not_found") {
        entry.plan = null;
        entry.etag = null;
      } else if (result.kind === "ok") {
        const parsed = inferencePlanSchema.safeParse(result.body);
        if (!parsed.success) throw new Error("Cloud inference plan response was invalid.");
        entry.plan = parsed.data;
        entry.etag = result.etag;
      } else if (!entry.plan) {
        throw new Error("Cloud answered 304 for an inference plan this Bridge does not hold.");
      }
      entry.fetchedAtMs = this.#nowMs();
      entry.failedAtMs = null;
    } catch (error) {
      if (!this.#current(entry, generation)) return null;
      entry.failedAtMs = this.#nowMs();
      // A 304 for a plan we do not hold must not keep being sent.
      if (!entry.plan) entry.etag = null;
      this.#options.onError?.(error);
    }
    return this.#snapshot(entry);
  }

  #current(entry: Entry, generation: number): boolean {
    return generation === this.#generation && this.#entry === entry;
  }

  #snapshot(entry: Entry): BridgeInferencePlanSnapshot | null {
    if (!entry.plan || entry.fetchedAtMs === null) return null;
    return {
      state: entry.failedAtMs === null ? "ready" : "stale",
      plan: entry.plan,
      fetchedAt: new Date(entry.fetchedAtMs).toISOString(),
      evaluatedFor: entry.evaluatedFor,
    };
  }
}
