import { z } from "zod";
import {
  CAPTURE_SOURCES,
  INFERENCE_PROVIDERS,
  ORG_FEATURES,
  globalControlNoticeSchema,
  globalControlTargetKey,
  globalControlTargetSchema,
  orgFeatureDefinition,
  orgPolicyActorSchema,
  type DesktopGlobalControl,
  type GlobalControlTarget,
  type InferenceProvider,
  type OrgFeatureKey,
  type OrgPolicy,
} from "./org-policy.js";

// Global controls (ADR-0296): Alexandria-wide kills for a provider, a model,
// or a registry feature marked `globalControl`. They only ever restrict: an
// active control turns its target off for every organization in scope, on top
// of (never instead of) each organization's policy. Cloud refuses killed
// providers and models when it grants inference; desktops apply every kill
// through `effectiveOrgPolicy` and show the notice.

const id = z.string().trim().min(1).max(200);
const isoTime = z.iso.datetime({ offset: true });

export const globalControlScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({
    mode: z.literal("all_except"),
    orgIds: z.array(id).min(1).max(1000)
      .refine((orgIds) => new Set(orgIds).size === orgIds.length, "duplicate organizations"),
  }).strict(),
]);
export type GlobalControlScope = z.infer<typeof globalControlScopeSchema>;

export const globalControlReasonSchema = z.string().trim().min(3).max(1000);

/** One stored global control. `enabled` is always false: a control only turns things off. */
export const globalControlSchema = z.object({
  target: globalControlTargetSchema,
  enabled: z.literal(false),
  scope: globalControlScopeSchema,
  /** Shown to people while the control is on. null = product wording. */
  notice: globalControlNoticeSchema.nullable().default(null),
  reason: globalControlReasonSchema,
  actor: orgPolicyActorSchema,
  createdAt: isoTime,
  /** null = until turned back on. An expired control is ignored everywhere. */
  expiresAt: isoTime.nullable(),
}).strict();
export type GlobalControl = z.infer<typeof globalControlSchema>;

/** Every control, at most one per target. */
export const globalControlsSchema = z.array(globalControlSchema).max(500)
  .refine((controls) => new Set(controls.map((control) => globalControlTargetKey(control.target))).size === controls.length, "duplicate targets");
export type GlobalControls = z.infer<typeof globalControlsSchema>;

/** Registry features Alexandria may turn off globally. */
export const GLOBAL_CONTROL_FEATURES: readonly OrgFeatureKey[] = ORG_FEATURES
  .filter((feature) => feature.globalControl === true)
  .map((feature) => feature.key);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Anything carrying a target and expiry; operator entries also carry a scope. */
export type GlobalKillLike = {
  readonly target: GlobalControlTarget;
  readonly expiresAt: string | null;
  readonly scope?: GlobalControlScope;
};

/**
 * Whether one control applies to `orgId` at `nowMs`. Expired entries never
 * apply. A session with no organization (personal) is inside every scope; it
 * can never be listed as an exception.
 */
export function globalControlApplies(control: GlobalKillLike, orgId: string | null, nowMs: number): boolean {
  if (control.expiresAt !== null) {
    const expiresAtMs = Date.parse(control.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return false;
  }
  const scope = control.scope;
  if (!scope || scope.mode === "all") return true;
  return orgId === null || !scope.orgIds.includes(orgId);
}

/** The kills a desktop in `orgId` receives: resolved, without scope or other organizations. */
export function globalKillsFor(
  controls: readonly (GlobalKillLike & { readonly notice?: string | null })[],
  orgId: string | null,
  nowMs: number,
): DesktopGlobalControl[] {
  return controls
    .filter((control) => globalControlApplies(control, orgId, nowMs))
    .map((control) => ({ target: { ...control.target }, notice: control.notice ?? null, expiresAt: control.expiresAt }))
    .sort((a, b) => globalControlTargetKey(a.target).localeCompare(globalControlTargetKey(b.target)));
}

export type GlobalKillSets = {
  readonly providers: ReadonlySet<InferenceProvider>;
  readonly models: ReadonlySet<string>;
  readonly features: ReadonlySet<OrgFeatureKey>;
};

export function globalKillSets(controls: readonly GlobalKillLike[], orgId: string | null, nowMs: number): GlobalKillSets {
  const providers = new Set<InferenceProvider>();
  const models = new Set<string>();
  const features = new Set<OrgFeatureKey>();
  for (const control of controls) {
    if (!globalControlApplies(control, orgId, nowMs)) continue;
    const target = control.target;
    if (target.kind === "provider") providers.add(target.id);
    else if (target.kind === "model") models.add(target.id);
    else features.add(target.key);
  }
  return { providers, models, features };
}

/** Features off because a killed feature is them or one they require. */
function featureKilled(key: OrgFeatureKey, killed: ReadonlySet<OrgFeatureKey>): boolean {
  for (let current: OrgFeatureKey | undefined = key; current; current = orgFeatureDefinition(current).requires) {
    if (killed.has(current)) return true;
  }
  return false;
}

/**
 * The policy with every applicable kill applied. Only restricts:
 * - killed features (and features that require them) are forced off;
 *   `actionsCapture` also removes pointer actions from capture and sharing;
 * - killed providers leave `allowedProviders` (null becomes the explicit
 *   remaining list) and `fallbackProviders`; a managed `provider` on a killed
 *   value moves to the first remaining fallback, then allowed provider, and is
 *   dropped when none remains. `allowedProviders` may end up empty.
 * - killed models leave `allowedModels`; managed model settings on a killed
 *   model are dropped (the server assignment applies). With `allowedModels`
 *   null, consumers also check `globalKillSets(...).models`.
 * The result is not re-validated (an empty provider list is meaningful here).
 */
export function effectiveOrgPolicy(
  policy: OrgPolicy,
  controls: readonly GlobalKillLike[],
  orgId: string | null,
  nowMs: number,
): OrgPolicy {
  const kills = globalKillSets(controls, orgId, nowMs);
  if (kills.providers.size === 0 && kills.models.size === 0 && kills.features.size === 0) return policy;
  const next = structuredClone(policy) as { -readonly [K in keyof OrgPolicy]: OrgPolicy[K] };

  if (kills.features.size > 0) {
    const features: Partial<Record<OrgFeatureKey, boolean>> = { ...next.features };
    for (const feature of ORG_FEATURES) {
      if (featureKilled(feature.key, kills.features)) features[feature.key] = false;
    }
    next.features = features;
    if (kills.features.has("actionsCapture")) {
      const capture = next.capture;
      capture.allowedSources = (capture.allowedSources ?? [...CAPTURE_SOURCES]).filter((source) => source !== "pointer_actions");
      if (capture.enabledSources) {
        capture.enabledSources = {
          ...capture.enabledSources,
          value: capture.enabledSources.value.filter((source) => source !== "pointer_actions"),
        };
      }
      capture.allowUnknownFocus = { ...capture.allowUnknownFocus, pointer: false };
      if (next.multiplayer?.dataTypes.pointer_actions) {
        next.multiplayer.dataTypes = { ...next.multiplayer.dataTypes, pointer_actions: { allowed: false } };
      }
    }
  }

  const inference = next.inference;
  if (kills.providers.size > 0) {
    const allowed = (inference.allowedProviders ?? [...INFERENCE_PROVIDERS]).filter((provider) => !kills.providers.has(provider));
    const fallback = inference.fallbackProviders?.filter((provider) => !kills.providers.has(provider)) ?? null;
    inference.allowedProviders = allowed;
    inference.fallbackProviders = fallback;
    if (inference.provider && kills.providers.has(inference.provider.value)) {
      const replacement = [...(fallback ?? []), ...allowed][0];
      if (replacement) inference.provider = { ...inference.provider, value: replacement };
      else delete inference.provider;
    }
  }
  if (kills.models.size > 0) {
    if (inference.allowedModels) inference.allowedModels = inference.allowedModels.filter((model) => !kills.models.has(model));
    if (inference.transcriptionModel && kills.models.has(inference.transcriptionModel.value)) delete inference.transcriptionModel;
    if (inference.retrievalModel && kills.models.has(inference.retrievalModel.value)) delete inference.retrievalModel;
  }
  return next as OrgPolicy;
}

/**
 * Legacy WorkOS slugs without killed features (and features that require
 * them). Cloud applies this to every organization in scope, with or without a
 * published policy, so builds that predate global controls lose the feature too.
 */
export function withoutGloballyDisabledSlugs(
  slugs: readonly string[],
  controls: readonly GlobalKillLike[],
  orgId: string | null,
  nowMs: number,
): string[] {
  const { features } = globalKillSets(controls, orgId, nowMs);
  if (features.size === 0) return [...slugs];
  const removed = new Set(ORG_FEATURES.filter((feature) => featureKilled(feature.key, features)).map((feature) => feature.legacySlug));
  return slugs.filter((slug) => !removed.has(slug));
}

// ---------------------------------------------------------------------------
// Refusal transport
// ---------------------------------------------------------------------------

/**
 * Cloud refuses a killed provider or model with the shipped `policy_denied`
 * grant code (or `BILLING_FORBIDDEN` on `/usage/reservations`) and a message
 * starting with this prefix. Older desktops show a generic error; newer ones
 * show the text after the prefix.
 */
export const GLOBALLY_DISABLED_PREFIX = "globally_disabled:";

export const INFERENCE_PROVIDER_LABELS: Readonly<Record<InferenceProvider, string>> = {
  confidential: "Confidential inference",
  "zero-retention": "Zero-retention inference",
  chatgpt: "ChatGPT",
  claude: "Claude",
};

export function globalControlTargetLabel(target: GlobalControlTarget): string {
  if (target.kind === "provider") return INFERENCE_PROVIDER_LABELS[target.id];
  if (target.kind === "model") return target.id;
  return orgFeatureDefinition(target.key).title;
}

export function globallyDisabledMessage(target: GlobalControlTarget, notice: string | null): string {
  const label = target.kind === "model" ? `The model ${target.id}` : globalControlTargetLabel(target);
  return `${GLOBALLY_DISABLED_PREFIX} ${notice ?? `${label} is temporarily unavailable.`}`;
}

/** Text to show for a `globally_disabled:` refusal, or null for any other message. */
export function parseGloballyDisabledMessage(message: string | null | undefined): string | null {
  if (!message?.startsWith(GLOBALLY_DISABLED_PREFIX)) return null;
  const text = message.slice(GLOBALLY_DISABLED_PREFIX.length).trim();
  return text || "This is temporarily unavailable.";
}

// ---------------------------------------------------------------------------
// Operator API (`/admin/global-controls*`)
// ---------------------------------------------------------------------------

/** Members whose desktop checked in this recently count as live. */
export const GLOBAL_CONTROL_LIVE_WINDOW_MS = 15 * 60 * 1_000;

export const GLOBAL_CONTROL_AUDIT_ACTIONS = ["turned_off", "updated", "turned_on"] as const;

export const globalControlAuditEntrySchema = z.object({
  id,
  target: globalControlTargetSchema,
  action: z.enum(GLOBAL_CONTROL_AUDIT_ACTIONS),
  actor: orgPolicyActorSchema,
  reason: z.string(),
  before: globalControlSchema.nullable(),
  after: globalControlSchema.nullable(),
  requestId: z.string().nullable(),
  createdAt: isoTime,
}).strict();
export type GlobalControlAuditEntry = z.infer<typeof globalControlAuditEntrySchema>;

/** PUT /admin/global-controls/:kind/:id — turn the target off (or change an active control). */
export const setGlobalControlRequestSchema = z.object({
  scope: globalControlScopeSchema,
  notice: globalControlNoticeSchema.nullable().default(null),
  /** Must be in the future. null = until turned back on. */
  expiresAt: isoTime.nullable().default(null),
  reason: globalControlReasonSchema,
}).strict();
export type SetGlobalControlRequest = z.infer<typeof setGlobalControlRequestSchema>;

/** DELETE /admin/global-controls/:kind/:id — turn the target back on. */
export const liftGlobalControlRequestSchema = z.object({
  reason: globalControlReasonSchema,
}).strict();

export const globalControlResponseSchema = z.object({
  control: globalControlSchema.nullable(),
}).strict();

/** GET /admin/global-controls */
export const globalControlListSchema = z.object({
  /** Stored controls, including expired ones (the console marks them). */
  controls: globalControlsSchema,
  /** Everything an operator may turn off. */
  targets: z.object({
    providers: z.array(z.object({ id: z.enum(INFERENCE_PROVIDERS), label: z.string() }).strict()),
    /** Live Cloud model catalog (same as `/admin/catalog` models). */
    models: z.array(z.object({ id: z.string(), roles: z.array(z.string()) }).strict()),
    features: z.array(z.object({ key: z.string(), title: z.string(), description: z.string() }).strict()),
  }).strict(),
  /** Newest first, at most 100. */
  history: z.array(globalControlAuditEntrySchema),
}).strict();
export type GlobalControlList = z.infer<typeof globalControlListSchema>;

/**
 * GET /admin/global-controls/impact?kind=&id=[&exceptOrgIds=a,b]
 * What turning the target off would touch right now.
 */
export const globalControlImpactSchema = z.object({
  target: globalControlTargetSchema,
  organizations: z.object({
    /** Organizations inside the scope (every known organization minus exceptions). */
    inScope: z.number().int().nonnegative(),
    /** In scope and currently allowed / enabled the target by their policy or defaults. */
    affected: z.number().int().nonnegative(),
  }).strict(),
  /** Members of affected organizations active within `GLOBAL_CONTROL_LIVE_WINDOW_MS`. */
  peopleLiveNow: z.number().int().nonnegative(),
  /** Inference requests in the last hour across affected organizations; null for features and for providers Cloud does not route. */
  requestsLastHour: z.number().int().nonnegative().nullable(),
  /** Most affected organizations first, at most 50. */
  topOrganizations: z.array(z.object({
    id,
    name: z.string(),
    peopleLiveNow: z.number().int().nonnegative(),
    requestsLastHour: z.number().int().nonnegative().nullable(),
  }).strict()).max(50),
}).strict();
export type GlobalControlImpact = z.infer<typeof globalControlImpactSchema>;

/** Route segment → target; null for an unknown or non-controllable target. */
export function parseGlobalControlTarget(kind: string, targetId: string): GlobalControlTarget | null {
  const candidate = kind === "feature" ? { kind, key: targetId } : { kind, id: targetId };
  const parsed = globalControlTargetSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
