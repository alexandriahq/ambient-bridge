import { z } from "zod";
export * from "./node-web-auth.js";

const identifier = z.string().trim().min(1).max(200);

export const cloudPrincipalSchema = z.object({
  id: identifier,
  provider: z.literal("workos"),
  workosUserId: identifier,
  status: z.enum(["active", "disabled"]),
}).strict();

export type CloudPrincipal = z.infer<typeof cloudPrincipalSchema>;

export const cloudUsageSubjectSchema = z.object({
  id: identifier,
  principalId: identifier,
  status: z.enum(["active", "disabled"]),
}).strict();

export type CloudUsageSubject = z.infer<typeof cloudUsageSubjectSchema>;

export const cloudWorkspaceKindSchema = z.enum(["personal", "workos_org"]);

export type CloudWorkspaceKind = z.infer<typeof cloudWorkspaceKindSchema>;

export const cloudWorkspaceSchema = z.object({
  id: identifier,
  kind: cloudWorkspaceKindSchema,
  workosOrganizationId: identifier.nullable(),
  status: z.enum(["active", "disabled"]),
}).strict().superRefine((workspace, context) => {
  if (workspace.kind === "personal" && workspace.workosOrganizationId !== null) {
    context.addIssue({
      code: "custom",
      message: "A personal workspace cannot be bound to a WorkOS organization.",
      path: ["workosOrganizationId"],
    });
  }
  if (workspace.kind === "workos_org" && workspace.workosOrganizationId === null) {
    context.addIssue({
      code: "custom",
      message: "A workos_org workspace requires a WorkOS organization.",
      path: ["workosOrganizationId"],
    });
  }
});

export type CloudWorkspace = z.infer<typeof cloudWorkspaceSchema>;

const entitlementFields = {
  inference: z.boolean(),
  multiplayer: z.boolean(),
  publishing: z.boolean(),
  mcp: z.boolean(),
};

export const cloudWorkspaceEntitlementsSchema = z.object(entitlementFields).strict();

export type CloudWorkspaceEntitlements = z.infer<typeof cloudWorkspaceEntitlementsSchema>;

export const cloudEntitlementPolicySchema = z.object({
  workspaceId: identifier,
  ...entitlementFields,
}).strict();

export type CloudEntitlementPolicy = z.infer<typeof cloudEntitlementPolicySchema>;

export const cloudBillingModeSchema = z.enum(["user_metered", "org_sponsored"]);

export const cloudBillingAccountSchema = z.object({
  id: identifier,
  ownerKind: z.enum(["user", "workos_org"]),
  ownerId: identifier,
  status: z.enum(["active", "suspended", "closed"]),
}).strict();

export type CloudBillingAccount = z.infer<typeof cloudBillingAccountSchema>;

const billingFields = {
  mode: cloudBillingModeSchema,
  billingAccountId: identifier,
  perUserAllowanceMicros: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  perUserHardLimitMicros: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  overage: z.enum(["deny", "user_pays", "org_pays"]),
  pricingVersion: identifier,
};

export const cloudBillingContextSchema = z.object(billingFields).strict();

export type CloudBillingContext = z.infer<typeof cloudBillingContextSchema>;

export const cloudBillingPolicySchema = z.object({
  workspaceId: identifier,
  ...billingFields,
}).strict();

export type CloudBillingPolicy = z.infer<typeof cloudBillingPolicySchema>;

export const cloudIdentityClaimsSchema = z.object({
  iss: z.string().url(),
  aud: z.string().min(1),
  sub: identifier,
  workspaceId: identifier,
  workspaceKind: cloudWorkspaceKindSchema,
  workosOrganizationId: identifier.nullable(),
  installationId: identifier,
  sessionEpoch: z.number().int().nonnegative(),
  entitlements: cloudWorkspaceEntitlementsSchema,
  billing: cloudBillingContextSchema,
  // Directory metadata is signed for an assigned Multiplayer Node. Older
  // identities may omit it; omission must never overwrite stored Node names.
  memberProfile: z.object({
    organizationName: z.string().min(1).max(200),
    email: z.string().min(1).max(320).nullable(),
    displayName: z.string().min(1).max(200).nullable(),
  }).strict().optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
}).strict().superRefine((claims, context) => {
  if (claims.workspaceKind === "personal" && claims.workosOrganizationId !== null) {
    context.addIssue({ code: "custom", path: ["workosOrganizationId"], message: "Personal identities cannot name a WorkOS organization." });
  }
  if (claims.workspaceKind === "workos_org" && claims.workosOrganizationId === null) {
    context.addIssue({ code: "custom", path: ["workosOrganizationId"], message: "Organization identities require a WorkOS organization." });
  }
  if (claims.memberProfile && (claims.workspaceKind !== "workos_org" || !claims.entitlements.multiplayer)) {
    context.addIssue({ code: "custom", path: ["memberProfile"], message: "Member profiles require an organization Multiplayer identity." });
  }
});

export type CloudIdentityClaims = z.infer<typeof cloudIdentityClaimsSchema>;

export const cloudIdentityTokenResponseSchema = z.object({
  tokenType: z.literal("Bearer"),
  accessToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  claims: cloudIdentityClaimsSchema,
  rotatedSessionToken: z.string().min(1).nullable(),
}).strict();

export type CloudIdentityTokenResponse = z.infer<typeof cloudIdentityTokenResponseSchema>;

export const cloudOrganizationSchema = z.object({
  id: identifier,
  name: z.string().trim().min(1).max(200),
}).strict();

export type CloudOrganization = z.infer<typeof cloudOrganizationSchema>;

export const cloudNodeCapabilitySchema = z.enum(["multiplayer", "publishing", "inference", "mcp"]);

export type CloudNodeCapability = z.infer<typeof cloudNodeCapabilitySchema>;

const cloudNodeHttpUrlSchema = z.string().url().refine(isCloudNodeHttpUrl, {
  message: "Node URLs must use HTTP(S) without credentials, query parameters, or fragments.",
});

export const cloudNodeInstallationSchema = z.object({
  id: identifier,
  audience: cloudNodeHttpUrlSchema,
  apiBaseUrl: cloudNodeHttpUrlSchema,
  capabilities: z.array(cloudNodeCapabilitySchema).min(1),
  inferenceMode: z.enum(["confidential", "plaintext"]),
  configurationVersion: z.number().int().positive(),
  status: z.enum(["active", "draining", "disabled"]),
}).strict().superRefine((installation, context) => {
  if (stripSlash(installation.apiBaseUrl) !== stripSlash(installation.audience)) {
    context.addIssue({
      code: "custom",
      message: "Node API base URL must equal its Cloud identity audience.",
      path: ["apiBaseUrl"],
    });
  }
});

export type CloudNodeInstallation = z.infer<typeof cloudNodeInstallationSchema>;

export const cloudNodeAssignmentRecordSchema = z.object({
  id: identifier,
  selector: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("workspace"), workspaceId: identifier }).strict(),
    z.object({ kind: z.literal("workspace_kind"), workspaceKind: cloudWorkspaceKindSchema }).strict(),
  ]),
  installationId: identifier,
  status: z.enum(["active", "disabled"]),
}).strict();

export type CloudNodeAssignmentRecord = z.infer<typeof cloudNodeAssignmentRecordSchema>;

export const cloudNodeAssignmentSchema = z.object({
  assignmentId: identifier,
  installationId: identifier,
  apiBaseUrl: cloudNodeHttpUrlSchema,
  audience: cloudNodeHttpUrlSchema,
  capabilities: z.array(cloudNodeCapabilitySchema).min(1),
  inferenceMode: z.enum(["confidential", "plaintext"]),
  configurationVersion: z.number().int().positive(),
}).strict().superRefine((assignment, context) => {
  if (stripSlash(assignment.apiBaseUrl) !== stripSlash(assignment.audience)) {
    context.addIssue({
      code: "custom",
      message: "Node API base URL must equal its Cloud identity audience.",
      path: ["apiBaseUrl"],
    });
  }
});

export type CloudNodeAssignment = z.infer<typeof cloudNodeAssignmentSchema>;

const cloudBootstrapBaseSchema = z.object({
  version: z.literal("alexandria-cloud-bootstrap/1"),
});

export const cloudBootstrapReadyResponseSchema = cloudBootstrapBaseSchema.extend({
  status: z.literal("ready"),
  workspace: cloudWorkspaceSchema,
  node: cloudNodeAssignmentSchema,
  entitlements: cloudEntitlementPolicySchema,
  billing: cloudBillingPolicySchema,
  identity: cloudIdentityTokenResponseSchema,
}).strict().superRefine((response, context) => {
  if (response.workspace.id !== response.identity.claims.workspaceId) {
    context.addIssue({ code: "custom", message: "Bootstrap workspace does not match identity.", path: ["workspace"] });
  }
  if (response.workspace.kind !== response.identity.claims.workspaceKind) {
    context.addIssue({ code: "custom", message: "Bootstrap workspace kind does not match identity.", path: ["workspace", "kind"] });
  }
  if (response.workspace.workosOrganizationId !== response.identity.claims.workosOrganizationId) {
    context.addIssue({ code: "custom", message: "Bootstrap organization binding does not match identity.", path: ["workspace", "workosOrganizationId"] });
  }
  if (response.node.installationId !== response.identity.claims.installationId) {
    context.addIssue({ code: "custom", message: "Bootstrap installation does not match identity.", path: ["node"] });
  }
  if (stripSlash(response.node.audience) !== stripSlash(response.identity.claims.aud)) {
    context.addIssue({ code: "custom", message: "Bootstrap audience does not match identity.", path: ["node", "audience"] });
  }
  if (response.entitlements.workspaceId !== response.workspace.id) {
    context.addIssue({ code: "custom", message: "Entitlements do not belong to the bootstrap workspace.", path: ["entitlements", "workspaceId"] });
  }
  if (response.billing.workspaceId !== response.workspace.id) {
    context.addIssue({ code: "custom", message: "Billing policy does not belong to the bootstrap workspace.", path: ["billing", "workspaceId"] });
  }
  const { workspaceId: _entitlementWorkspaceId, ...entitlements } = response.entitlements;
  if (JSON.stringify(entitlements) !== JSON.stringify(response.identity.claims.entitlements)) {
    context.addIssue({ code: "custom", message: "Bootstrap entitlements do not match identity.", path: ["entitlements"] });
  }
  const { workspaceId: _billingWorkspaceId, ...billing } = response.billing;
  if (JSON.stringify(billing) !== JSON.stringify(response.identity.claims.billing)) {
    context.addIssue({ code: "custom", message: "Bootstrap billing policy does not match identity.", path: ["billing"] });
  }
});

export const cloudBootstrapNoOrganizationResponseSchema = cloudBootstrapBaseSchema.extend({
  status: z.literal("no_organization"),
  organizations: z.array(cloudOrganizationSchema).max(0),
  rotatedSessionToken: z.string().min(1).nullable(),
}).strict();

export const cloudBootstrapOrganizationSelectionResponseSchema = cloudBootstrapBaseSchema.extend({
  status: z.literal("organization_selection_required"),
  organizations: z.array(cloudOrganizationSchema).min(1),
  rotatedSessionToken: z.string().min(1).nullable(),
}).strict();

export const cloudBootstrapNodeNotProvisionedResponseSchema = cloudBootstrapBaseSchema.extend({
  status: z.literal("node_not_provisioned"),
  workspace: cloudWorkspaceSchema,
  rotatedSessionToken: z.string().min(1).nullable(),
}).strict();

/** The org contracts fewer seats than active members and this member does not hold one (seat enforcement `block`). */
export const cloudBootstrapSeatLimitReachedResponseSchema = cloudBootstrapBaseSchema.extend({
  status: z.literal("seat_limit_reached"),
  workspace: cloudWorkspaceSchema,
  rotatedSessionToken: z.string().min(1).nullable(),
}).strict();

export const cloudBootstrapResponseSchema = z.union([
  cloudBootstrapReadyResponseSchema,
  cloudBootstrapNoOrganizationResponseSchema,
  cloudBootstrapOrganizationSelectionResponseSchema,
  cloudBootstrapNodeNotProvisionedResponseSchema,
  cloudBootstrapSeatLimitReachedResponseSchema,
]);

export type CloudBootstrapReadyResponse = z.infer<typeof cloudBootstrapReadyResponseSchema>;
export type CloudBootstrapResponse = z.infer<typeof cloudBootstrapResponseSchema>;

export const cloudJwkSchema = z.object({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string().min(1),
  kid: identifier,
  alg: z.literal("EdDSA"),
  use: z.literal("sig"),
}).passthrough();

export const cloudJwksSchema = z.object({
  keys: z.array(cloudJwkSchema).min(1),
}).strict();

export type CloudJwk = z.infer<typeof cloudJwkSchema>;
export type CloudJwks = z.infer<typeof cloudJwksSchema>;

export const cloudCapabilitySchema = z.object({
  version: z.literal("alexandria-cloud/1"),
  issuer: z.string().url(),
  jwksUri: z.string().url(),
  identityTokenEndpoint: z.string().url(),
  bootstrapEndpoint: z.string().url(),
  inferenceGrantEndpoint: z.string().url(),
  inferenceReceiptEndpoint: z.string().url(),
  inferenceBaseUrl: z.string().url(),
}).strict();

export type CloudCapability = z.infer<typeof cloudCapabilitySchema>;

export const CLOUD_IDENTITY_HEADER = "x-alexandria-identity";
export const CLOUD_INSTALLATION_ID_HEADER = "x-alexandria-installation-id";
export const CLOUD_INSTALLATION_ASSERTION_HEADER = "x-alexandria-installation-assertion";

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isCloudNodeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}
export * from "./org-policy.js";
export * from "./policy-layers.js";
export * from "./plans.js";
export * from "./global-controls.js";
export * from "./org-admin-api.js";
export * from "./org-commercial-api.js";
