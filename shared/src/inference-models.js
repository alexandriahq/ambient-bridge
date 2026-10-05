import { z } from "zod";
import {
  DEFAULT_INFERENCE_MODEL_ASSIGNMENT,
  INFERENCE_MODEL_ROLES,
  inferenceModelAssignmentSchema,
} from "@alexandria/cloud-contract/inference-model-assignment";

export { DEFAULT_INFERENCE_MODEL_ASSIGNMENT, INFERENCE_MODEL_ROLES, inferenceModelAssignmentSchema };

/**
 * Server-authored inference model assignment.
 *
 * The Ambient app used to hardcode VLM / STT / redaction / chunk model ids.
 * Those roles are now resolved from this document (fetched via Bridge from
 * `GET /inference/models`), with the contract's canonical default as the offline bake.
 *
 * The sealed EHBP proxy cannot rewrite `payload.model`, so failover is a
 * control-plane concern: operators mark models unavailable (or change role
 * primaries) and clients resolve the next healthy candidate before the next
 * request.
 */

export const inferenceModelsSnapshotSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    source: z.literal("server"),
    assignment: inferenceModelAssignmentSchema,
    fetchedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    state: z.literal("stale"),
    source: z.literal("server"),
    assignment: inferenceModelAssignmentSchema,
    fetchedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    state: z.literal("offline_default"),
    source: z.literal("baked"),
    assignment: inferenceModelAssignmentSchema,
    fetchedAt: z.null(),
    reason: z.enum(["signed_out", "offline", "server_error"]),
  }).strict(),
]);

export function parseInferenceModelAssignment(value) {
  return inferenceModelAssignmentSchema.parse(value);
}

export function parseInferenceModelsSnapshot(value) {
  return inferenceModelsSnapshotSchema.parse(value);
}

export function defaultInferenceModelAssignment() {
  return parseInferenceModelAssignment(DEFAULT_INFERENCE_MODEL_ASSIGNMENT);
}

/**
 * Resolve the model id for a role, skipping unavailable primaries in favor of
 * configured fallbacks. Returns the primary if every candidate is unavailable
 * (fail-open to the configured primary so inference can still be attempted).
 */
export function resolveInferenceRoleModel(assignment, role) {
  const roleAssignment = assignment.roles[role];
  if (!roleAssignment) {
    throw new Error(`Unknown inference model role: ${role}`);
  }
  const unavailable = new Set(assignment.unavailableModelIds);
  const candidates = [roleAssignment.modelId, ...roleAssignment.fallbackModelIds];
  for (const modelId of candidates) {
    if (!unavailable.has(modelId)) return modelId;
  }
  return roleAssignment.modelId;
}

/** Apply sunset remaps, then keep the id only when it remains in the chat catalog. */
export function remapInferenceChatModel(assignment, modelId) {
  const remapped = assignment.sunsetRemaps[modelId] ?? modelId;
  if (assignment.catalog.chat.some((entry) => entry.id === remapped)) return remapped;
  return resolveInferenceRoleModel(assignment, "chunkAnalysis");
}

export function catalogLabelForModel(assignment, modelId) {
  const chat = assignment.catalog.chat.find((entry) => entry.id === modelId);
  if (chat) return chat.label;
  const stt = assignment.catalog.stt.find((entry) => entry.id === modelId);
  return stt?.label ?? modelId;
}
