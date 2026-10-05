import {
  defaultInferenceModelAssignment,
  parseInferenceModelAssignment,
  type InferenceModelAssignment,
  type InferenceModelsSnapshot,
} from "@ambient/shared/inference-models";
import { AuthServerRequestError, AuthServerTimeoutError } from "../auth/server-client.js";
import { SessionOwnerCache, type CachedSessionValue } from "./session-owner-cache.js";

/** Coalesced server assignment with the shared offline bake when unreachable. */
export class BridgeModelAssignmentCache extends SessionOwnerCache<InferenceModelAssignment, InferenceModelsSnapshot> {
  constructor(freshTtlMs = 60_000, nowMs: () => number = Date.now) {
    super(freshTtlMs, nowMs, {
      signedOut: () => Promise.resolve(offlineDefault("signed_out")),
      retired: () => offlineDefault("server_error"),
      prepare: parseInferenceModelAssignment,
      ready: (cached) => snapshot("ready", cached),
      failed: (error, cached) => cached ? snapshot("stale", cached) : offlineDefault(offlineReason(error)),
    });
  }
}

function snapshot(
  state: "ready" | "stale",
  cached: CachedSessionValue<InferenceModelAssignment>,
): InferenceModelsSnapshot {
  return {
    state,
    source: "server",
    assignment: cached.value,
    fetchedAt: new Date(cached.fetchedAtMs).toISOString(),
  };
}

function offlineDefault(
  reason: Extract<InferenceModelsSnapshot, { state: "offline_default" }>["reason"],
): InferenceModelsSnapshot {
  return {
    state: "offline_default",
    source: "baked",
    assignment: defaultInferenceModelAssignment(),
    fetchedAt: null,
    reason,
  };
}

function offlineReason(error: unknown): Extract<InferenceModelsSnapshot, { state: "offline_default" }>["reason"] {
  if (error instanceof AuthServerRequestError && error.status === 401) return "signed_out";
  if (error instanceof AuthServerTimeoutError || error instanceof TypeError) return "offline";
  return "server_error";
}
