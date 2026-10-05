import type { UsageSnapshot, UsageSummary } from "@ambient/shared/usage";
import { AuthServerRequestError, AuthServerTimeoutError, AuthServerUsageError } from "../auth/server-client.js";
import { SessionOwnerCache, type CachedSessionValue } from "./session-owner-cache.js";

export class BridgeUsageCache extends SessionOwnerCache<UsageSummary, UsageSnapshot> {
  constructor(freshTtlMs = 30_000, nowMs: () => number = Date.now) {
    super(freshTtlMs, nowMs, {
      signedOut: () => Promise.resolve({ state: "unavailable", reason: "signed_out" }),
      retired: () => ({ state: "unavailable", reason: "server_error" }),
      ready: (cached) => snapshot("ready", cached),
      prepare: (summary, expectedOwnerKey) => {
        if (`${summary.owner.kind}:${summary.owner.id}` !== expectedOwnerKey) {
          throw new Error("Usage summary owner did not match the active session.");
        }
        return summary;
      },
      observe: (summary) => this.observe(summary),
      failed: (error, cached) => cached
        ? snapshot("stale", cached)
        : { state: "unavailable", reason: unavailableReason(error) },
    });
  }

  observe(summary: UsageSummary, fetchedAtMs = this.nowMs()): void {
    this.observeValue(summary, `${summary.owner.kind}:${summary.owner.id}`, fetchedAtMs);
  }
}

function snapshot(state: "ready" | "stale", cached: CachedSessionValue<UsageSummary>): UsageSnapshot {
  return { state, summary: cached.value, fetchedAt: new Date(cached.fetchedAtMs).toISOString() };
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
