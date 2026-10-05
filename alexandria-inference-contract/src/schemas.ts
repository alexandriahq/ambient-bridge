import { z } from "zod";

const identifier = z.string().trim().min(1).max(200);
const url = z.string().url();
const isoDateTime = z.string().datetime({ offset: true });

export const inferenceRouteSchema = z.enum([
  "chat.completions",
  "responses",
  "audio.transcriptions",
  "embeddings",
]);
export type InferenceRoute = z.infer<typeof inferenceRouteSchema>;

const basePolicyFields = {
  profile: identifier,
  providers: z.array(identifier).min(1).max(20),
  models: z.array(identifier).min(1).max(100),
  regions: z.array(identifier).max(20).default([]),
  retainContent: z.boolean().default(false),
};

export const confidentialInferencePolicySchema = z.object({
  mode: z.literal("confidential"),
  minimumAssurance: z.literal("attested"),
  denyDowngrade: z.literal(true),
  executors: z.array(z.enum(["alexandria", "tinfoil"])).min(1),
  ...basePolicyFields,
}).strict();

export const plaintextInferencePolicySchema = z.object({
  mode: z.literal("plaintext"),
  explicitOptIn: z.literal(true),
  exposure: z.literal("provider-readable"),
  ...basePolicyFields,
}).strict();

export const inferencePolicySchema = z.discriminatedUnion("mode", [
  confidentialInferencePolicySchema,
  plaintextInferencePolicySchema,
]);
export type InferencePolicy = z.infer<typeof inferencePolicySchema>;

export const inferenceGrantRequestSchema = z.object({
  version: z.literal("aci/1"),
  requestId: identifier,
  idempotencyKey: z.string().trim().min(8).max(200),
  installationId: identifier,
  subject: identifier,
  workspaceId: identifier,
  workosOrganizationId: identifier.nullable(),
  usageSubjectId: identifier,
  feature: identifier,
  route: inferenceRouteSchema,
  model: identifier,
  requestedPolicy: inferencePolicySchema,
  deadline: isoDateTime,
}).strict();
export type InferenceGrantRequest = z.infer<typeof inferenceGrantRequestSchema>;

export const inferenceTargetSchema = z.object({
  url,
  executor: z.enum(["alexandria", "tinfoil", "openrouter", "bedrock"]),
  provider: identifier,
  model: identifier,
  requestedModel: identifier.optional(),
  region: identifier.nullable(),
  keySessionRequired: z.boolean(),
}).strict();
export type InferenceTarget = z.infer<typeof inferenceTargetSchema>;

export const inferenceGrantClaimsSchema = z.object({
  iss: url,
  aud: url,
  sub: z.literal("inference-grant"),
  jti: identifier,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  requestId: identifier,
  installationId: identifier,
  subjectId: identifier,
  workspaceId: identifier,
  workosOrganizationId: identifier.nullable(),
  usageSubjectId: identifier,
  feature: identifier,
  route: inferenceRouteSchema,
  policy: inferencePolicySchema,
  target: inferenceTargetSchema,
  reservation: z.object({
    id: identifier,
    pricingVersion: identifier,
    maximumChargeMicros: z.string().regex(/^(0|[1-9][0-9]*)$/),
  }).strict(),
  billing: z.object({
    mode: z.enum(["user_metered", "org_sponsored"]),
    billingAccountId: identifier,
    pricingVersion: identifier,
  }).strict(),
}).strict().superRefine((claims, context) => {
  if (claims.exp <= claims.iat) {
    context.addIssue({ code: "custom", path: ["exp"], message: "exp must be after iat" });
  }
  if (claims.policy.mode === "confidential" && !claims.target.keySessionRequired) {
    context.addIssue({
      code: "custom",
      path: ["target", "keySessionRequired"],
      message: "confidential grants require an attested key session",
    });
  }
  if (claims.policy.mode === "plaintext" && claims.target.keySessionRequired) {
    context.addIssue({
      code: "custom",
      path: ["target", "keySessionRequired"],
      message: "plaintext grants cannot name a key session",
    });
  }
  if (claims.policy.mode === "confidential" && ["openrouter", "bedrock"].includes(claims.target.executor)) {
    context.addIssue({
      code: "custom",
      path: ["target", "executor"],
      message: "A provider-readable executor cannot execute a confidential grant",
    });
  }
  if (claims.target.executor === "bedrock" && (
    claims.target.provider !== "bedrock" || !claims.target.region || !claims.target.requestedModel
    || claims.policy.retainContent || !claims.policy.providers.includes("bedrock")
    || !claims.policy.models.includes(claims.target.requestedModel)
    || claims.policy.regions.length !== 1 || claims.policy.regions[0] !== claims.target.region
  )) {
    context.addIssue({ code: "custom", path: ["target"], message: "Bedrock requires a region-bound, non-retaining model policy" });
  }
  if (claims.target.requestedModel !== undefined && claims.target.executor !== "bedrock") {
    context.addIssue({ code: "custom", path: ["target", "requestedModel"], message: "Only Bedrock grants support legacy model migration" });
  }
});
export type InferenceGrantClaims = z.infer<typeof inferenceGrantClaimsSchema>;

export const signedInferenceGrantSchema = z.object({
  version: z.literal("aci/1"),
  grant: z.string().min(1),
  claims: inferenceGrantClaimsSchema,
}).strict();
export type SignedInferenceGrant = z.infer<typeof signedInferenceGrantSchema>;

export const keySessionSchema = z.object({
  version: z.literal("aci/1"),
  deploymentId: identifier,
  keyId: identifier,
  hpke: z.object({
    kem: z.literal("DHKEM_X25519_HKDF_SHA256"),
    kdf: z.literal("HKDF_SHA256"),
    aead: z.literal("AES_256_GCM"),
    publicKey: z.string().min(1),
  }).strict(),
  evidence: z.object({
    format: z.enum(["tinfoil-bundle", "eat-jwt", "aws-nitro-document", "nvidia-attestation"]),
    value: z.string().min(1),
    nonce: z.string().min(1),
  }).strict(),
  referenceValues: z.object({
    policyId: identifier,
    imageDigest: z.string().startsWith("sha256:"),
    modelDigest: z.string().startsWith("sha256:").nullable(),
    sourceRevision: identifier,
  }).strict(),
  notBefore: isoDateTime,
  notAfter: isoDateTime,
  inferenceUrl: url,
}).strict();
export type KeySession = z.infer<typeof keySessionSchema>;

export const inferenceUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  audioSeconds: z.number().nonnegative().nullable(),
}).strict();

export const inferenceTerminalReceiptStatusSchema = z.enum(["succeeded", "failed", "cancelled"]);
export const inferenceReceiptStatusSchema = z.enum(["accepted", "succeeded", "failed", "cancelled"]);
export type InferenceReceiptStatus = z.infer<typeof inferenceReceiptStatusSchema>;

/**
 * Standard SQS preserves a message's original enqueue timestamp when it moves
 * to a DLQ, so the production topology provides at most fourteen days of queue
 * retention in total. The longer receipt validity leaves an operator-redrive
 * and recovery window after queue transport has expired.
 */
export const INFERENCE_USAGE_RECEIPT_VALIDITY_SECONDS = 31 * 24 * 60 * 60;

export const inferenceUsageReceiptClaimsSchema = z.object({
  iss: url,
  aud: url,
  sub: z.literal("inference-usage-receipt"),
  jti: identifier,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  grantId: identifier,
  requestId: identifier,
  installationId: identifier,
  workspaceId: identifier,
  workosOrganizationId: identifier.nullable(),
  usageSubjectId: identifier,
  reservationId: identifier,
  billing: z.object({
    mode: z.enum(["user_metered", "org_sponsored"]),
    billingAccountId: identifier,
    pricingVersion: identifier,
  }).strict(),
  provider: identifier,
  model: identifier,
  route: inferenceRouteSchema,
  mode: z.enum(["confidential", "plaintext"]),
  status: inferenceReceiptStatusSchema,
  usage: inferenceUsageSchema,
  safeErrorCode: identifier.nullable(),
}).strict().superRefine((claims, context) => {
  if (
    claims.status === "accepted"
    && (
      claims.usage.promptTokens !== 0
      || claims.usage.completionTokens !== 0
      || claims.usage.totalTokens !== 0
      || claims.usage.audioSeconds !== null
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "An accepted inference event cannot report provider usage.",
      path: ["usage"],
    });
  }
  if (claims.status === "accepted" && claims.safeErrorCode !== null) {
    context.addIssue({
      code: "custom",
      message: "An accepted inference event cannot report a terminal error.",
      path: ["safeErrorCode"],
    });
  }
});
export type InferenceUsageReceiptClaims = z.infer<typeof inferenceUsageReceiptClaimsSchema>;

export const signedInferenceUsageReceiptSchema = z.object({
  version: z.literal("aci/1"),
  receipt: z.string().min(1),
  claims: inferenceUsageReceiptClaimsSchema,
}).strict();
export type SignedInferenceUsageReceipt = z.infer<typeof signedInferenceUsageReceiptSchema>;

const inferenceReceiptAcknowledgementFields = {
  receiptId: identifier,
  reservationId: identifier,
  requestId: identifier,
};

export const inferenceReceiptAcknowledgementSchema = z.union([
  z.object({
    ...inferenceReceiptAcknowledgementFields,
    status: z.literal("accepted"),
    accepted: z.literal(true),
  }).strict(),
  z.object({
    ...inferenceReceiptAcknowledgementFields,
    status: inferenceTerminalReceiptStatusSchema,
    accepted: z.literal(false),
  }).strict(),
]);
export type InferenceReceiptAcknowledgement = z.infer<typeof inferenceReceiptAcknowledgementSchema>;

export const inferenceCapabilitySchema = z.object({
  protocolVersions: z.tuple([z.literal("aci/1")]),
  modes: z.array(z.enum(["confidential", "plaintext"])).min(1),
  evidenceFormats: z.array(identifier),
  routes: z.array(inferenceRouteSchema),
  grantEndpoint: url,
  keySessionEndpoint: url,
  requestEndpoint: url,
  maxBodyBytes: z.number().int().positive(),
  maxStreamSeconds: z.number().int().positive(),
}).strict();
export type InferenceCapability = z.infer<typeof inferenceCapabilitySchema>;

export const inferenceErrorCodeSchema = z.enum([
  "validation_failed",
  "authentication_required",
  "principal_forbidden",
  "policy_denied",
  "plaintext_not_enabled",
  "assurance_unavailable",
  "attestation_failed",
  "key_expired",
  "grant_expired",
  "replay_detected",
  "credit_exhausted",
  "capacity_exhausted",
  "provider_unavailable",
  "deadline_exceeded",
  "request_cancelled",
]);
export type InferenceErrorCode = z.infer<typeof inferenceErrorCodeSchema>;

export const inferenceErrorSchema = z.object({
  error: z.object({
    code: inferenceErrorCodeSchema,
    message: z.string().min(1).max(500),
    requestId: identifier.nullable(),
    retryable: z.boolean(),
  }).strict(),
}).strict();

export const ALEXANDRIA_GRANT_HEADER = "x-alexandria-inference-grant";
export const ALEXANDRIA_KEY_ID_HEADER = "x-alexandria-key-id";
export const ALEXANDRIA_REQUEST_ID_HEADER = "x-alexandria-request-id";
export const ALEXANDRIA_MODEL_HEADER = "x-alexandria-model";
export const ALEXANDRIA_FEATURE_HEADER = "x-alexandria-feature";
export const ALEXANDRIA_MODE_HEADER = "x-alexandria-inference-mode";
export const ALEXANDRIA_USAGE_RECEIPT_HEADER = "x-alexandria-usage-receipt";
export const EHBP_REQUEST_HEADER = "ehbp-encapsulated-key";
export const EHBP_RESPONSE_HEADER = "ehbp-response-nonce";
