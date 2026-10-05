import type { SignedInWorkOsSession } from "../workos/session.js";
import { sessionUsageOwnerKey } from "./availability.js";

export interface CachedSessionValue<Value> {
  readonly ownerKey: string;
  readonly value: Value;
  readonly fetchedAtMs: number;
}

interface SessionCachePolicy<Value, Snapshot> {
  readonly signedOut: () => Promise<Snapshot>;
  readonly retired: () => Snapshot;
  readonly ready: (cached: CachedSessionValue<Value>) => Snapshot;
  readonly prepare?: (value: Value, ownerKey: string) => Value;
  readonly observe?: (value: Value) => void;
  readonly failed?: (error: unknown, cached: CachedSessionValue<Value> | null) => Snapshot;
}

export class SessionOwnerCache<Value, Snapshot> {
  #cached: CachedSessionValue<Value> | null = null;
  #inFlight: Promise<Snapshot> | null = null;
  #activeOwnerKey: string | null = null;
  #generation = 0;
  readonly #policy: SessionCachePolicy<Value, Snapshot>;

  constructor(
    private readonly freshTtlMs: number,
    protected readonly nowMs: () => number,
    policy: SessionCachePolicy<Value, Snapshot>,
  ) {
    this.#policy = policy;
  }

  read(input: {
    readonly session: SignedInWorkOsSession | null;
    readonly force?: boolean;
    readonly load: (session: SignedInWorkOsSession) => Promise<Value>;
  }): Promise<Snapshot> {
    if (!input.session) {
      this.clear();
      return this.#policy.signedOut();
    }
    const ownerKey = sessionUsageOwnerKey(input.session);
    if (this.#activeOwnerKey !== ownerKey) {
      this.clear();
      this.#activeOwnerKey = ownerKey;
    }
    const nowMs = this.nowMs();
    if (!input.force && this.#cached && nowMs - this.#cached.fetchedAtMs < this.freshTtlMs) {
      return Promise.resolve(this.#policy.ready(this.#cached));
    }
    if (this.#inFlight) return this.#inFlight;
    const generation = this.#generation;
    const inFlight = this.#load(input.session, ownerKey, generation, input.load).finally(() => {
      if (this.#inFlight === inFlight) this.#inFlight = null;
    });
    this.#inFlight = inFlight;
    return inFlight;
  }

  protected observeValue(value: Value, ownerKey: string, fetchedAtMs: number): void {
    if (this.#activeOwnerKey !== ownerKey) {
      this.clear();
      this.#activeOwnerKey = ownerKey;
    }
    this.#cached = { ownerKey, value, fetchedAtMs };
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
    load: (session: SignedInWorkOsSession) => Promise<Value>,
  ): Promise<Snapshot> {
    try {
      let value: Value = await load(session);
      if (this.#policy.prepare) value = this.#policy.prepare(value, expectedOwnerKey);
      if (generation !== this.#generation || this.#activeOwnerKey !== expectedOwnerKey) {
        return this.#policy.retired();
      }
      if (this.#policy.observe) this.#policy.observe(value);
      else this.#cached = { ownerKey: expectedOwnerKey, value, fetchedAtMs: this.nowMs() };
      return this.#policy.ready(this.#cached!);
    } catch (error) {
      if (!this.#policy.failed) throw error;
      const cached = this.#cached?.ownerKey === expectedOwnerKey ? this.#cached : null;
      return this.#policy.failed(error, cached);
    }
  }
}
