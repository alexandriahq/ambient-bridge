import type { BridgeInferenceRequestStatus, BridgeRequestLogPatch, BridgeRequestLogSnapshot } from "./bridge-api";

/** Default hydrate / retention budget for the Bridge window request log. */
export const BRIDGE_REQUEST_LOG_LIMIT = 40;

/**
 * Merge a request-log patch into the current newest-first list.
 * Unchanged rows keep their object identity so Svelte can skip rework.
 */
export function applyRequestLogPatch(
  current: readonly BridgeInferenceRequestStatus[],
  patch: BridgeRequestLogPatch,
  limit = BRIDGE_REQUEST_LOG_LIMIT,
): BridgeInferenceRequestStatus[] {
  const capped = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : BRIDGE_REQUEST_LOG_LIMIT;
  const base = patch.reset ? [] : current;
  const byId = new Map<string, BridgeInferenceRequestStatus>();
  for (const row of base) byId.set(row.requestId, row);

  for (const id of patch.removeIds ?? []) byId.delete(id);
  for (const upsert of patch.upserts) {
    const previous = byId.get(upsert.requestId);
    byId.set(upsert.requestId, previous && sameRequestRow(previous, upsert) ? previous : upsert);
  }

  const order: string[] = [];
  const seen = new Set<string>();
  for (const upsert of patch.upserts) {
    if (seen.has(upsert.requestId) || !byId.has(upsert.requestId)) continue;
    order.push(upsert.requestId);
    seen.add(upsert.requestId);
  }
  for (const row of base) {
    if (seen.has(row.requestId) || !byId.has(row.requestId)) continue;
    order.push(row.requestId);
    seen.add(row.requestId);
  }

  return order
    .slice(0, capped)
    .map((id) => byId.get(id)!)
    .filter(Boolean);
}

export function requestLogFromSnapshot(
  snapshot: BridgeRequestLogSnapshot,
  limit = BRIDGE_REQUEST_LOG_LIMIT,
): BridgeInferenceRequestStatus[] {
  const capped = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : BRIDGE_REQUEST_LOG_LIMIT;
  return snapshot.requests.slice(0, capped);
}

function sameRequestRow(
  left: BridgeInferenceRequestStatus,
  right: BridgeInferenceRequestStatus,
): boolean {
  return left.requestId === right.requestId
    && left.status === right.status
    && left.statusCode === right.statusCode
    && left.completedAt === right.completedAt
    && left.startedAt === right.startedAt
    && left.attestation === right.attestation
    && left.wireCaptured === right.wireCaptured
    && left.error === right.error
    && left.model === right.model
    && left.feature === right.feature
    && left.path === right.path
    && left.requestBytes === right.requestBytes
    && left.ehbpResponseNonce === right.ehbpResponseNonce
    && left.tinfoilRequestId === right.tinfoilRequestId
    && left.usage?.totalTokens === right.usage?.totalTokens
    && left.usage?.promptTokens === right.usage?.promptTokens
    && left.usage?.completionTokens === right.usage?.completionTokens;
}
