import { z } from "zod";
import {
  AGENT_IDS,
  CAPTURE_SOURCES,
  COMPANY_PROFILES,
  MULTIPLAYER_DATA_TYPES,
  ORG_FEATURE_GROUPS,
  INFERENCE_PROVIDERS,
  ONBOARDING_STEPS,
  ORG_FEATURES,
  orgPolicyAuditEntrySchema,
  orgPolicyDraftSchema,
  orgPolicySchema,
  orgPolicyVersionSchema,
} from "./org-policy.js";
import { POLICY_LAYER_KINDS } from "./policy-layers.js";

// Wire shapes for the operator API Alexandria Cloud serves under `/admin/*`
// to the Alexandria console (UI and MCP). Every route requires an operator:
// a WorkOS session for the Alexandria organization with the `admin` role.

const id = z.string().trim().min(1).max(200);
const reason = z.string().trim().min(3).max(1000);

export const operatorIdentitySchema = z.object({
  userId: id,
  email: z.string().nullable(),
  name: z.string().nullable(),
  organizationId: id,
  role: z.literal("admin"),
}).strict();
export type OperatorIdentity = z.infer<typeof operatorIdentitySchema>;

export const adminOrganizationSummarySchema = z.object({
  id,
  name: z.string(),
  domains: z.array(z.string()),
  createdAt: z.string(),
  publishedVersion: z.number().int().positive().nullable(),
  publishedAt: z.string().nullable(),
  hasDraft: z.boolean(),
  /** `defaults` = a policy layer other targets inherit from (no WorkOS organization). Absent from older Clouds = organization. */
  kind: z.enum(POLICY_LAYER_KINDS).optional(),
  /** Layer this target inherits from, nearest first. Absent from older Clouds. */
  inheritsFrom: z.array(id).max(8).optional(),
}).strict();
export type AdminOrganizationSummary = z.infer<typeof adminOrganizationSummarySchema>;

export const adminOrganizationListSchema = z.object({
  organizations: z.array(adminOrganizationSummarySchema),
}).strict();

export const adminOrganizationDetailSchema = z.object({
  organization: adminOrganizationSummarySchema,
  published: orgPolicyVersionSchema.nullable(),
  draft: orgPolicyDraftSchema.nullable(),
  /** Nodes this organization's members are assigned to (ADR-0313: they bound its usable modes). Absent from older Clouds. */
  installationIds: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  /**
   * What this target inherits: its ancestors' published policies merged
   * (null = nothing above it is published). The console shows these values
   * for every setting this policy leaves at the product default.
   */
  inherited: z.object({
    layers: z.array(z.object({ id, name: z.string(), version: z.number().int().positive() }).strict()).max(8),
    policy: orgPolicySchema,
  }).strict().nullable().optional(),
}).strict();
export type AdminOrganizationDetail = z.infer<typeof adminOrganizationDetailSchema>;

export const policyIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
}).strict();
export type PolicyIssue = z.infer<typeof policyIssueSchema>;

export const validatePolicyResponseSchema = z.object({
  valid: z.boolean(),
  issues: z.array(policyIssueSchema),
}).strict();

/** PUT /admin/organizations/:orgId/policy/draft */
export const saveDraftRequestSchema = z.object({
  policy: z.unknown(),
  /** Current draft revision; null when creating the draft. Mismatch → 409. */
  expectedRevision: z.number().int().positive().nullable(),
}).strict();

/** POST /admin/organizations/:orgId/policy/publish */
export const publishDraftRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason,
}).strict();

/** POST /admin/organizations/:orgId/policy/rollback */
export const rollbackRequestSchema = z.object({
  version: z.number().int().positive(),
  /** Latest published version the operator saw. Mismatch → 409. */
  expectedVersion: z.number().int().positive(),
  reason,
}).strict();

export const policyVersionListSchema = z.object({
  versions: z.array(orgPolicyVersionSchema),
}).strict();

/** POST /admin/organizations/:orgId/policy/validate */
export const validatePolicyRequestSchema = z.object({
  policy: z.unknown(),
}).strict();

/** DELETE /admin/organizations/:orgId/policy/draft */
export const discardDraftRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
}).strict();

/** PUT/DELETE …/policy/draft response. */
export const draftResponseSchema = z.object({
  draft: orgPolicyDraftSchema.nullable(),
}).strict();

/** POST …/policy/publish and …/policy/rollback response. */
export const publishedResponseSchema = z.object({
  published: orgPolicyVersionSchema,
}).strict();

/** GET …/policy/versions/:version */
export const policyVersionResponseSchema = z.object({
  version: orgPolicyVersionSchema,
}).strict();

/** GET …/policy/audit — newest first, at most 100. */
export const policyAuditListSchema = z.object({
  entries: z.array(orgPolicyAuditEntrySchema),
}).strict();

export const adminErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      "OPERATOR_AUTH_REQUIRED",
      "OPERATOR_FORBIDDEN",
      "NOT_FOUND",
      "INVALID_REQUEST",
      "INVALID_POLICY",
      "REVISION_CONFLICT",
      "UNAVAILABLE",
      "INVALID_CATALOG",
      "INVALID_PRICES",
      "INVALID_INSTALLATION",
    ]),
    message: z.string(),
    issues: z.array(policyIssueSchema).optional(),
  }).strict(),
}).strict();
export type AdminError = z.infer<typeof adminErrorSchema>;

/** GET /admin/catalog — everything an editor (human or agent) needs to build a valid policy. */
export const policyCatalogSchema = z.object({
  schemaVersion: z.number().int(),
  features: z.array(z.object({
    key: z.string(),
    title: z.string(),
    group: z.string(),
    description: z.string(),
    defaultEnabled: z.boolean(),
    requires: z.string().optional(),
    legacySlug: z.string(),
  }).strict()),
  inferenceProviders: z.array(z.string()),
  captureSources: z.array(z.string()),
  agents: z.array(z.string()),
  onboardingSteps: z.array(z.string()),
  companyProfiles: z.array(z.string()),
  multiplayerDataTypes: z.array(z.string()),
  featureGroups: z.array(z.string()),
  /** Model ids from the live Cloud model assignment catalog. */
  models: z.array(z.object({ id: z.string(), roles: z.array(z.string()) }).strict()),
  /** JSON Schema for the policy document. */
  policyJsonSchema: z.unknown(),
}).strict();
export type PolicyCatalog = z.infer<typeof policyCatalogSchema>;

export function staticPolicyCatalog(): Omit<PolicyCatalog, "models"> {
  return {
    schemaVersion: 1,
    // `globalControl` stays off this wire shape (strict on deployed consoles); see global-controls.ts.
    features: ORG_FEATURES.map(({ globalControl: _globalControl, ...feature }) => ({ ...feature })),
    inferenceProviders: [...INFERENCE_PROVIDERS],
    captureSources: [...CAPTURE_SOURCES],
    agents: [...AGENT_IDS],
    onboardingSteps: [...ONBOARDING_STEPS],
    companyProfiles: [...COMPANY_PROFILES],
    multiplayerDataTypes: [...MULTIPLAYER_DATA_TYPES],
    featureGroups: [...ORG_FEATURE_GROUPS],
    policyJsonSchema: z.toJSONSchema(orgPolicySchema, { io: "input", unrepresentable: "any" }),
  };
}
