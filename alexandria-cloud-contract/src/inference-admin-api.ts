import { z } from "zod";
import {
  inferenceCatalogSchema,
  inferenceCatalogVersionSchema,
  inferencePriceVersionRecordSchema,
  inferencePriceVersionSchema,
  INFERENCE_PRICE_VERSION_PATTERN,
  INFERENCE_MODES,
  inferenceModeSchema,
} from "./inference-catalog.js";

// Operator API for the inference catalog and prices (ADR-0297). Every route is
// operator-only (`ALEXANDRIA_OPERATOR_ORGANIZATION_ID` admins), like the other
// `/admin/*` routes the Alexandria console calls.
//
//   GET    /admin/inference/catalog                    -> inferenceCatalogStateSchema
//   PUT    /admin/inference/catalog/draft              body saveInferenceCatalogDraftSchema -> inferenceCatalogStateSchema
//   DELETE /admin/inference/catalog/draft              -> inferenceCatalogStateSchema
//   POST   /admin/inference/catalog/publish            body publishInferenceCatalogSchema   -> inferenceCatalogVersionSchema
//   GET    /admin/inference/catalog/versions           -> inferenceCatalogHistorySchema
//   GET    /admin/inference/catalog/versions/:version  -> inferenceCatalogVersionSchema
//   GET    /admin/inference/prices                     -> inferencePriceStateSchema
//   POST   /admin/inference/prices                     body inferencePriceVersionSchema     -> inferencePriceVersionRecordSchema
//   POST   /admin/inference/prices/:version/activate   -> inferencePriceVersionRecordSchema
//   GET    /admin/inference/installations              -> inferenceInstallationListSchema (read-only, ADR-0325)
//
// Errors use `adminErrorSchema` (org-admin-api.ts): a stale `expectedRevision`
// or an existing price version answers 409 `REVISION_CONFLICT`; a catalog or
// price version that fails validation (schema, unexecutable routes, missing
// prices) answers 422 `INVALID_CATALOG` / `INVALID_PRICES` with `issues`
// (`{ path, message }`). A Node's modes are deploy config
// (`ALEXANDRIA_INSTALLATIONS_JSON` `modes`/`inferenceMode`, ADR-0325); there is
// no write route for them.

const actor = z.string().max(320);
const timestamp = z.iso.datetime({ offset: true });

export const inferenceCatalogDraftSchema = z.object({
  /** Increments on every draft write; used for optimistic concurrency. */
  revision: z.number().int().positive(),
  catalog: inferenceCatalogSchema,
  updatedBy: actor,
  updatedAt: timestamp,
}).strict();
export type InferenceCatalogDraft = z.infer<typeof inferenceCatalogDraftSchema>;

export const inferenceCatalogStateSchema = z.object({
  /** `environment` only while the database has no catalog (seeding has not run): `effective` is derived from Railway variables. */
  source: z.enum(["database", "environment"]),
  /** The catalog Cloud enforces right now. */
  effective: inferenceCatalogSchema,
  published: inferenceCatalogVersionSchema.nullable(),
  draft: inferenceCatalogDraftSchema.nullable(),
  /** Problems that would refuse publishing the draft, beyond schema validation (unexecutable routes, missing prices). */
  warnings: z.array(z.string().max(500)).max(100),
}).strict();
export type InferenceCatalogState = z.infer<typeof inferenceCatalogStateSchema>;

export const saveInferenceCatalogDraftSchema = z.object({
  /** null when no draft exists yet. */
  expectedRevision: z.number().int().positive().nullable(),
  catalog: inferenceCatalogSchema,
}).strict();

export const publishInferenceCatalogSchema = z.object({
  expectedRevision: z.number().int().positive(),
  note: z.string().trim().max(500).optional(),
}).strict();

export const inferenceCatalogHistorySchema = z.object({
  versions: z.array(z.object({
    version: z.number().int().positive(),
    publishedBy: actor,
    publishedAt: timestamp,
    note: z.string().max(500).optional(),
  }).strict()).max(200),
}).strict();

export const inferencePriceStateSchema = z.object({
  source: z.enum(["database", "environment"]),
  active: z.string().regex(INFERENCE_PRICE_VERSION_PATTERN).nullable(),
  /** Newest first. */
  versions: z.array(inferencePriceVersionRecordSchema).max(200),
}).strict();
export type InferencePriceState = z.infer<typeof inferencePriceStateSchema>;

export { inferencePriceVersionSchema as createInferencePriceVersionSchema };

/**
 * The modes one Node can serve and its default (ADR-0313, ADR-0325). Deploy
 * config, shown read-only. Released desktops use `defaultMode`, which Cloud
 * sends as the bootstrap `inferenceMode`.
 */
export const inferenceInstallationModesSchema = z.object({
  installationId: z.string().trim().min(1).max(200),
  modes: z.array(inferenceModeSchema).min(1).max(INFERENCE_MODES.length)
    .refine((list) => new Set(list).size === list.length, "duplicate modes"),
  defaultMode: inferenceModeSchema,
  /**
   * The Node's operator acknowledged provider-readable inference (Terraform
   * `plaintext_inference_acknowledged`). Without it Zero Data Retention cannot
   * be enabled here, and the Node refuses it anyway.
   */
  zeroRetentionAcknowledged: z.boolean(),
  /**
   * `environment`: the registry (`modes`, else `[inferenceMode]`). `database`:
   * a legacy row the retired console editor saved, in effect until the
   * registry entry sets `modes`; `updatedBy`/`updatedAt` describe that row.
   */
  source: z.enum(["database", "environment"]),
  updatedBy: actor.optional(),
  updatedAt: timestamp.optional(),
}).strict().refine((value) => value.modes.includes(value.defaultMode), { path: ["defaultMode"], message: "The default mode must be served." });
export type InferenceInstallationModes = z.infer<typeof inferenceInstallationModesSchema>;

export const inferenceInstallationListSchema = z.object({
  installations: z.array(inferenceInstallationModesSchema).max(500),
}).strict();
export type InferenceInstallationList = z.infer<typeof inferenceInstallationListSchema>;
