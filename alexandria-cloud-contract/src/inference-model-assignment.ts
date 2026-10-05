import { z } from "zod";

/** Released desktop assignment contract, shared by Cloud validation and offline clients. */
export const INFERENCE_MODEL_ROLES = Object.freeze([
  "chunkAnalysis",
  "intentLoop",
  "screenVlm",
  "stt",
  "redaction",
] as const);

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;
const modelIdSchema = z.string().regex(MODEL_ID_PATTERN);

const catalogEntrySchema = z.object({
  id: modelIdSchema,
  label: z.string().min(1).max(80),
}).strict();

const roleAssignmentSchema = z.object({
  modelId: modelIdSchema,
  fallbackModelIds: z.array(modelIdSchema).max(8).default([]),
}).strict();

export const inferenceModelAssignmentSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
  roles: z.object({
    chunkAnalysis: roleAssignmentSchema,
    intentLoop: roleAssignmentSchema,
    screenVlm: roleAssignmentSchema,
    stt: roleAssignmentSchema,
    redaction: roleAssignmentSchema,
  }).strict(),
  catalog: z.object({
    chat: z.array(catalogEntrySchema).min(1).max(32),
    stt: z.array(catalogEntrySchema).min(1).max(16),
  }).strict(),
  sunsetRemaps: z.record(modelIdSchema, modelIdSchema).default({}),
  /**
   * Operator-marked (or future health-probe) models the client must skip when
   * resolving a role. Empty in the baked default.
   */
  unavailableModelIds: z.array(modelIdSchema).max(64).default([]),
}).strict().superRefine((assignment, ctx) => {
  const chatIds = new Set(assignment.catalog.chat.map((entry) => entry.id));
  const sttIds = new Set(assignment.catalog.stt.map((entry) => entry.id));
  const requireChat = (role: string, modelId: string, path: (string | number)[]) => {
    if (!chatIds.has(modelId)) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `${role} model ${modelId} must appear in catalog.chat`,
      });
    }
  };
  const requireStt = (modelId: string, path: (string | number)[]) => {
    if (!sttIds.has(modelId)) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `stt model ${modelId} must appear in catalog.stt`,
      });
    }
  };

  requireChat("chunkAnalysis", assignment.roles.chunkAnalysis.modelId, ["roles", "chunkAnalysis", "modelId"]);
  for (const [index, modelId] of assignment.roles.chunkAnalysis.fallbackModelIds.entries()) {
    requireChat("chunkAnalysis", modelId, ["roles", "chunkAnalysis", "fallbackModelIds", index]);
  }
  requireChat("intentLoop", assignment.roles.intentLoop.modelId, ["roles", "intentLoop", "modelId"]);
  for (const [index, modelId] of assignment.roles.intentLoop.fallbackModelIds.entries()) {
    requireChat("intentLoop", modelId, ["roles", "intentLoop", "fallbackModelIds", index]);
  }
  requireChat("screenVlm", assignment.roles.screenVlm.modelId, ["roles", "screenVlm", "modelId"]);
  for (const [index, modelId] of assignment.roles.screenVlm.fallbackModelIds.entries()) {
    requireChat("screenVlm", modelId, ["roles", "screenVlm", "fallbackModelIds", index]);
  }
  requireChat("redaction", assignment.roles.redaction.modelId, ["roles", "redaction", "modelId"]);
  for (const [index, modelId] of assignment.roles.redaction.fallbackModelIds.entries()) {
    requireChat("redaction", modelId, ["roles", "redaction", "fallbackModelIds", index]);
  }
  requireStt(assignment.roles.stt.modelId, ["roles", "stt", "modelId"]);
  for (const [index, modelId] of assignment.roles.stt.fallbackModelIds.entries()) {
    requireStt(modelId, ["roles", "stt", "fallbackModelIds", index]);
  }

  for (const [from, to] of Object.entries(assignment.sunsetRemaps)) {
    if (!chatIds.has(to) && !sttIds.has(to)) {
      ctx.addIssue({
        code: "custom",
        path: ["sunsetRemaps", from],
        message: `sunset remap target ${to} must appear in a catalog`,
      });
    }
  }
});

export type InferenceModelAssignment = z.infer<typeof inferenceModelAssignmentSchema>;

/** Canonical offline/default assignment. Keep provider and model policy changes explicit. */
export const DEFAULT_INFERENCE_MODEL_ASSIGNMENT = Object.freeze({
  schemaVersion: 1,
  version: "tinfoil-2026-09-22-deepseek-v4-1-flash",
  roles: {
    chunkAnalysis: {
      modelId: "deepseek-v4-1-flash",
      fallbackModelIds: ["gemma4-31b"],
    },
    intentLoop: {
      modelId: "deepseek-v4-1-flash",
      fallbackModelIds: ["gemma4-31b"],
    },
    screenVlm: {
      modelId: "deepseek-v4-1-flash",
      fallbackModelIds: ["gemma4-31b"],
    },
    stt: {
      modelId: "whisper-large-v3-turbo",
      fallbackModelIds: [],
    },
    redaction: {
      modelId: "deepseek-v4-1-flash",
      fallbackModelIds: ["gemma4-31b"],
    },
  },
  catalog: {
    chat: [
      { id: "glm-5-2", label: "GLM-5.2" },
      { id: "kimi-k3", label: "Kimi K3" },
      { id: "deepseek-v4-1-flash", label: "DeepSeek V4.1 Flash" },
      { id: "gemma4-31b", label: "Gemma 4 31B" },
      { id: "gpt-oss-120b", label: "GPT-OSS 120B" },
      { id: "llama3-3-70b", label: "Llama 3.3 70B" },
    ],
    stt: [
      { id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo" },
    ],
  },
  sunsetRemaps: {
    "kimi-k2-6": "deepseek-v4-1-flash",
    "glm-5-1": "deepseek-v4-1-flash",
    "deepseek-v4-pro": "deepseek-v4-1-flash",
    "glm-5-2": "deepseek-v4-1-flash",
    "deepseek-v4-flash": "deepseek-v4-1-flash",
  },
  unavailableModelIds: [],
} satisfies InferenceModelAssignment);
