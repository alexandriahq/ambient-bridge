import { z } from "zod";
import { INFERENCE_JOBS, INFERENCE_MODES, inferenceCatalogModel, inferenceModeSchema, inferenceModelIdSchema, type InferenceCatalog, type InferenceJob, type InferenceMode, type OrgInferenceSettings } from "./inference-catalog.js";

// Organization policy: the one Cloud-owned description of what an
// organization's Ambient looks like after sign-in (features, managed settings,
// onboarding, data sharing). Alexandria operators edit it in the Alexandria
// console; Bridge pulls the published version and the app applies it. Builds
// stay universal — nothing here is compiled into a per-customer app.

export const ORG_POLICY_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Feature registry
// ---------------------------------------------------------------------------

export const ORG_FEATURE_KEYS = [
  "agents",
  "agentConnections",
  "reports",
  "serviceIntegrations",
  "actionsCapture",
  "devtools",
  "modelDetails",
  "automations",
  "automationToggleTrack",
  "observationsInSidebar",
  "actionsInSidebar",
] as const;

export type OrgFeatureKey = (typeof ORG_FEATURE_KEYS)[number];
export const orgFeatureKeySchema = z.enum(ORG_FEATURE_KEYS);

/** `developer` = internal / developer tooling, not a customer product feature. */
export const ORG_FEATURE_GROUPS = ["assistant", "workspace", "capture", "developer"] as const;
export type OrgFeatureGroup = (typeof ORG_FEATURE_GROUPS)[number];

export interface OrgFeatureDefinition {
  readonly key: OrgFeatureKey;
  readonly title: string;
  readonly group: OrgFeatureGroup;
  readonly description: string;
  /** Value when the policy leaves the feature unset. */
  readonly defaultEnabled: boolean;
  /** Feature only takes effect when this one is on too. */
  readonly requires?: OrgFeatureKey;
  /** WorkOS flag slug this feature replaces; emitted for older desktop builds. */
  readonly legacySlug: string;
  /** Alexandria may turn this feature off for every organization at once (global controls). */
  readonly globalControl?: true;
}

export const ORG_FEATURES: readonly OrgFeatureDefinition[] = [
  { key: "agents", title: "Agents", group: "assistant", defaultEnabled: false, legacySlug: "enable-agents", globalControl: true,
    description: "Agents tab, suggested tasks, automatic task launch, and new agent execution." },
  { key: "agentConnections", title: "Agent connections", group: "assistant", defaultEnabled: false, legacySlug: "enable-agent-connections",
    description: "Connecting coding agents (Claude Code, Codex, …) to Ambient context." },
  { key: "reports", title: "Reports", group: "assistant", defaultEnabled: false, legacySlug: "enable-reports", globalControl: true,
    description: "Daily Reports, report preparation, notifications, and sharing." },
  { key: "serviceIntegrations", title: "Service integrations", group: "workspace", defaultEnabled: false, legacySlug: "integrations-enabled",
    description: "Settings → Connections → Services (Slack, Linear, … via Composio)." },
  { key: "actionsCapture", title: "Actions capture", group: "capture", defaultEnabled: false, legacySlug: "enable-actions-capture", globalControl: true,
    description: "Pointer/click action capture on desktop." },
  { key: "devtools", title: "Developer tooling", group: "developer", defaultEnabled: false, legacySlug: "devtools-visible",
    description: "Internal and developer-only tooling, including permission diagnostics." },
  { key: "modelDetails", title: "Model details", group: "developer", defaultEnabled: false, legacySlug: "show-model-details",
    description: "Shows model ids, harness lanes and routing details in the UI." },
  { key: "automations", title: "Automations", group: "developer", defaultEnabled: false, legacySlug: "automations-enabled",
    description: "Automations area." },
  { key: "automationToggleTrack", title: "Toggl Track automation", group: "developer", defaultEnabled: false,
    requires: "automations", legacySlug: "automations-toggle-track-available",
    description: "Toggl Track time-entry automation." },
  { key: "observationsInSidebar", title: "Observations in sidebar", group: "developer", defaultEnabled: false,
    legacySlug: "show-chunk-analysis-page",
    description: "Shows processed chunks (observations) in the sidebar. Placement only." },
  { key: "actionsInSidebar", title: "Actions in sidebar", group: "developer", defaultEnabled: false, legacySlug: "show-actions-page",
    description: "Shows captured actions in the sidebar. Placement only." },
];

export function orgFeatureDefinition(key: OrgFeatureKey): OrgFeatureDefinition {
  const definition = ORG_FEATURES.find((feature) => feature.key === key);
  if (!definition) throw new Error(`Unknown org feature: ${key}`);
  return definition;
}

// ---------------------------------------------------------------------------
// Managed settings
// ---------------------------------------------------------------------------

/**
 * How the org controls one setting.
 * - `locked`: org value applies; the user sees it read-only.
 * - `default`: org value is the starting point; the user may change it.
 * - `hidden`: org value applies and the control is not shown at all.
 * A setting absent from the policy is unmanaged (product default, user-owned).
 */
export const MANAGED_MODES = ["locked", "default", "hidden"] as const;
export type ManagedMode = (typeof MANAGED_MODES)[number];

export function managedSetting<T extends z.ZodType>(value: T) {
  return z.object({ mode: z.enum(MANAGED_MODES), value }).strict();
}

export type Managed<T> = { readonly mode: ManagedMode; readonly value: T };

const shortId = z.string().trim().min(1).max(200);

export const INFERENCE_PROVIDERS = ["confidential", "zero-retention", "chatgpt", "claude"] as const;
export const inferenceProviderSchema = z.enum(INFERENCE_PROVIDERS);
export type InferenceProvider = z.infer<typeof inferenceProviderSchema>;

export const CAPTURE_SOURCES = [
  "screen",
  "microphone",
  "system_audio",
  "keyboard_input",
  "pointer_actions",
  "active_app_window",
] as const;
export const captureSourceSchema = z.enum(CAPTURE_SOURCES);
export type CaptureSource = z.infer<typeof captureSourceSchema>;

export const AGENT_IDS = ["claude", "codex", "opencode", "grok", "copilot"] as const;
export const agentIdSchema = z.enum(AGENT_IDS);
export type AgentId = z.infer<typeof agentIdSchema>;

export const blockRuleSchema = z.object({
  target: z.enum(["app", "website"]),
  pattern: z.string().trim().min(1).max(256),
}).strict();
export type BlockRule = z.infer<typeof blockRuleSchema>;

export const orgAppRuleSchema = z.object({
  target: z.enum(["app", "website"]),
  /** Bundle id / app name, or domain / URL pattern. */
  pattern: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(120).optional(),
  list: z.enum(["recorded", "excluded"]),
  mode: z.enum(["locked", "default"]),
}).strict();
export type OrgAppRule = z.infer<typeof orgAppRuleSchema>;

const uniqueList = <T extends z.ZodType>(item: T, max: number) =>
  z.array(item).max(max).refine((list) => new Set(list.map((value) => JSON.stringify(value))).size === list.length, "duplicate entries");

const orgJobSettingsSchema = z.object(Object.fromEntries(INFERENCE_JOBS.map((job) => [job, managedSetting(inferenceModelIdSchema).optional()])) as
  Record<InferenceJob, z.ZodOptional<ReturnType<typeof managedSetting<typeof inferenceModelIdSchema>>>>).strict();

export const orgInferencePolicySchema = z.object({
  /** null = every provider allowed. */
  allowedProviders: uniqueList(inferenceProviderSchema, INFERENCE_PROVIDERS.length).min(1).nullable().default(null),
  provider: managedSetting(inferenceProviderSchema).optional(),
  /** Ordered fallbacks tried when the selected provider is unavailable. Empty = fail closed. */
  fallbackProviders: uniqueList(inferenceProviderSchema, INFERENCE_PROVIDERS.length).nullable().default(null),
  /** null = every assigned model allowed. Model ids from the Cloud model catalog. */
  allowedModels: uniqueList(shortId, 200).nullable().default(null),
  transcriptionModel: managedSetting(shortId).optional(),
  retrievalModel: managedSetting(shortId).optional(),
  // ADR-0297. The fields below replace `allowedModels`, `transcriptionModel` and
  // `retrievalModel`; Cloud derives those for released desktops
  // (`desktopCompatibleOrgPolicy`) and never sends these to them.
  /** Inference modes this organization may use. null = every mode the catalog offers. */
  modes: uniqueList(inferenceModeSchema, INFERENCE_MODES.length).min(1).nullable().optional(),
  /** Allowed models per mode. Absent or null = everything the catalog offers in that mode. */
  models: z.object({
    confidential: uniqueList(inferenceModelIdSchema, 200).nullable().optional(),
    "zero-retention": uniqueList(inferenceModelIdSchema, 200).nullable().optional(),
  }).strict().optional(),
  /**
   * The mode people use (ADR-0313): the default, and whether they may switch
   * to another allowed mode (`default`), see it but not change it (`locked`)
   * or never see the choice (`hidden`). Absent = the Node's default mode.
   */
  mode: managedSetting(inferenceModeSchema).optional(),
  /** Per mode, per job: the default model and whether people see (`default`), see but cannot change (`locked`) or never see (`hidden`) the choice. */
  jobs: z.object({
    confidential: orgJobSettingsSchema.optional(),
    "zero-retention": orgJobSettingsSchema.optional(),
  }).strict().optional(),
  // ADR-0324. Not sent to released desktops either (`desktopCompatibleOrgPolicy`).
  /**
   * Modes people cannot use and never see (ADR-0324). A mode outside `modes`
   * and not hidden is *disabled*: shown as unavailable, with its notice.
   */
  hiddenModes: uniqueList(inferenceModeSchema, INFERENCE_MODES.length).optional(),
  /** Shown next to a disabled mode, e.g. "Confidential inference is at capacity." */
  modeNotices: z.object({
    confidential: z.string().trim().min(1).max(300).optional(),
    "zero-retention": z.string().trim().min(1).max(300).optional(),
  }).strict().optional(),
  /** Jobs that run only on the person's own ChatGPT or Claude; no Alexandria model is offered for them. */
  agentOnlyJobs: uniqueList(z.enum(INFERENCE_JOBS), INFERENCE_JOBS.length).optional(),
}).strict();
export type OrgInferencePolicy = z.infer<typeof orgInferencePolicySchema>;

const LEGACY_INFERENCE_KEYS = ["modes", "mode", "models", "jobs", "modeNotices", "hiddenModes", "agentOnlyJobs"] as const;

/**
 * The organization's inference narrowing for plan resolution. Policies written
 * before ADR-0297 only have the flat fields; read them as the same narrowing
 * for every mode.
 */
export function orgInferenceSettings(inference: OrgInferencePolicy): OrgInferenceSettings {
  const legacyModels = inference.allowedModels ?? null;
  const models: Partial<Record<InferenceMode, readonly string[] | null>> = {};
  for (const mode of INFERENCE_MODES) {
    const explicit = inference.models?.[mode];
    models[mode] = explicit !== undefined ? explicit : legacyModels;
  }
  // The flat transcription/retrieval fields apply in every mode that does not set the job.
  const jobs: Partial<Record<InferenceMode, NonNullable<NonNullable<OrgInferenceSettings["jobs"]>[InferenceMode]>>> = {};
  for (const mode of INFERENCE_MODES) {
    const modeJobs: Record<string, unknown> = { ...(inference.jobs?.[mode] ?? {}) };
    if (!modeJobs.transcription && inference.transcriptionModel) modeJobs.transcription = inference.transcriptionModel;
    if (!modeJobs.retrieval && inference.retrievalModel) modeJobs.retrieval = inference.retrievalModel;
    if (Object.keys(modeJobs).length > 0) jobs[mode] = modeJobs as NonNullable<typeof jobs[InferenceMode]>;
  }
  const legacyModes = inference.allowedProviders?.filter((provider): provider is InferenceMode =>
    (INFERENCE_MODES as readonly string[]).includes(provider)) ?? null;
  return {
    modes: inference.modes !== undefined ? inference.modes : legacyModes && legacyModes.length > 0 ? legacyModes : null,
    ...(inference.mode ? { mode: inference.mode } : {}),
    models,
    jobs,
    ...(inference.modeNotices ? { modeNotices: inference.modeNotices } : {}),
    ...(inference.hiddenModes?.length ? { hiddenModes: inference.hiddenModes } : {}),
    ...(inference.agentOnlyJobs?.length ? { agentOnlyJobs: inference.agentOnlyJobs } : {}),
  };
}

/**
 * Released desktops parse `GET /v1/org-policy` with the schema they shipped,
 * which is strict: strip the ADR-0297 fields and fill the flat ones they read.
 * They know models by their released-client ids, so name models by the
 * catalog's first alias (and list every alias as allowed).
 */
export function desktopCompatibleOrgPolicy(policy: OrgPolicy, catalog?: InferenceCatalog): OrgPolicy {
  const inference = { ...policy.inference } as Record<string, unknown>;
  const settings = orgInferenceSettings(policy.inference);
  for (const key of LEGACY_INFERENCE_KEYS) delete inference[key];
  const known = (id: string) => (catalog && inferenceCatalogModel(catalog, id)) || null;
  const legacyId = (id: string) => known(id)?.aliases[0] ?? id;
  const allIds = (id: string) => { const model = known(id); return model ? [model.id, ...model.aliases] : [id]; };
  // Only modes the organization may use can widen what released desktops see.
  const usableModes = settings.modes ?? INFERENCE_MODES;
  const perMode = usableModes.map((mode) => settings.models?.[mode] ?? null);
  inference.allowedModels = perMode.some((list) => list === null) ? policy.inference.allowedModels ?? null
    : [...new Set(perMode.flatMap((list) => (list ?? []).flatMap(allIds)))].slice(0, 200);
  const legacyJob = (setting: { readonly mode: ManagedMode; readonly value: string } | undefined) =>
    setting ? { mode: setting.mode, value: legacyId(setting.value) } : undefined;
  // Released desktops know one mode; read jobs from the organization's default mode first.
  const preferred = settings.mode?.value ?? "zero-retention";
  const jobFor = (job: "transcription" | "retrieval") =>
    settings.jobs?.[preferred]?.[job] ?? INFERENCE_MODES.map((mode) => settings.jobs?.[mode]?.[job]).find((setting) => setting !== undefined);
  const transcription = jobFor("transcription");
  const retrieval = jobFor("retrieval");
  if (transcription) inference.transcriptionModel = legacyJob(transcription);
  if (retrieval) inference.retrievalModel = legacyJob(retrieval);
  // Released desktops pick their route from `allowedProviders`, which also
  // carries the ChatGPT/Claude agent connections: keep those, add the modes.
  if (policy.inference.modes) {
    const agents = (policy.inference.allowedProviders ?? INFERENCE_PROVIDERS)
      .filter((provider) => !(INFERENCE_MODES as readonly string[]).includes(provider));
    inference.allowedProviders = [...policy.inference.modes, ...agents];
  }
  // Commercial terms are Cloud's; released desktops' strict schema predates them.
  const { pricing: _pricing, ...desktop } = policy;
  return { ...desktop, inference: inference as OrgInferencePolicy } as OrgPolicy;
}

export const REDACTION_LEVELS = ["full", "credentials", "off"] as const;
export type RedactionLevel = (typeof REDACTION_LEVELS)[number];
export const CHAIN_TEXT_VIEWS = ["raw", "redacted"] as const;
export type ChainTextView = (typeof CHAIN_TEXT_VIEWS)[number];

export const orgCapturePolicySchema = z.object({
  /** null = every source allowed. Sources outside the list are unavailable. */
  allowedSources: uniqueList(captureSourceSchema, CAPTURE_SOURCES.length).nullable().default(null),
  /** Sources enabled for a new install; user may change unless mode is locked/hidden. */
  enabledSources: managedSetting(uniqueList(captureSourceSchema, CAPTURE_SOURCES.length)).optional(),
  /**
   * Org app/website rules for the Sources lists (recorded = "only include
   * these", excluded = "exclude these"). `locked`: enforced, the person cannot
   * move or remove it. `default`: placed in that list once; the person may
   * move or remove it. People keep editing their own items.
   */
  appRules: z.array(orgAppRuleSchema).max(512)
    .refine((rules) => new Set(rules.map((rule) => `${rule.target}|${rule.pattern.toLowerCase()}`)).size === rules.length, "duplicate rules")
    .default([]),
  /** Whether people may add their own app/website items. */
  peopleCanAddRules: z.boolean().default(true),
  /** Per-column Sources mode: exclude listed items, or record only listed items (ADR-0245). */
  listMode: z.object({
    apps: managedSetting(z.enum(["exclude", "include"])).optional(),
    websites: managedSetting(z.enum(["exclude", "include"])).optional(),
  }).strict().default({}),
  /** Apply the built-in default excluded apps (password managers, …). */
  defaultExcludedApps: managedSetting(z.boolean()).optional(),
  /** Text redaction level (ADR-0215). Replaces WorkOS `text-redaction-default-off`. */
  redactionLevel: managedSetting(z.enum(REDACTION_LEVELS)).optional(),
  /** Which chain text the reasoning model reads. */
  reasoningInput: managedSetting(z.enum(CHAIN_TEXT_VIEWS)).optional(),
  /** Which chain text memory writes read. */
  memoryInput: managedSetting(z.enum(CHAIN_TEXT_VIEWS)).optional(),
  /**
   * Capture keystrokes / pointer actions when the focused element is unknown
   * (ADR-0208/0209). Replaces `keyboard-capture-allow-unknown` /
   * `pointer-capture-allow-unknown`.
   */
  allowUnknownFocus: z.object({ keyboard: z.boolean().default(false), pointer: z.boolean().default(false) }).strict()
    .default({ keyboard: false, pointer: false }),
}).strict();
export type OrgCapturePolicy = z.infer<typeof orgCapturePolicySchema>;

export const orgAgentsPolicySchema = z.object({
  /** null = every agent allowed. */
  allowedAgents: uniqueList(agentIdSchema, AGENT_IDS.length).nullable().default(null),
  /** Agents set up automatically when installed locally. With a policy, empty = none. */
  autoConnectAgents: uniqueList(agentIdSchema, AGENT_IDS.length).default([]),
  defaultAgent: managedSetting(agentIdSchema).optional(),
  autoHandoff: managedSetting(z.boolean()).optional(),
  /** Guidance for suggested tasks (ADR-0263). */
  customInstructions: managedSetting(z.string().max(4000)).optional(),
  /** Approximate useful suggestions per day (ADR-0263). */
  dailyTarget: managedSetting(z.number().int().min(1).max(50)).optional(),
}).strict();
export type OrgAgentsPolicy = z.infer<typeof orgAgentsPolicySchema>;

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

/** Steps the desktop knows how to render. Sign-in is shared and not configurable. */
export const ONBOARDING_STEPS = ["privacy", "local", "sources", "provider", "done"] as const;
export const onboardingStepSchema = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

const copyText = (max: number) => z.string().trim().min(1).max(max);

export const onboardingStepConfigSchema = z.object({
  id: onboardingStepSchema,
  /** Optional per-org copy. Absent = product copy. */
  title: copyText(120).optional(),
  body: copyText(600).optional(),
}).strict();

export const orgOnboardingPolicySchema = z.object({
  /**
   * Ordered steps shown after sign-in. null = product default flow. Steps whose
   * settings are all locked or hidden are skipped by the desktop regardless.
   */
  steps: z.array(onboardingStepConfigSchema).max(ONBOARDING_STEPS.length)
    .refine((steps) => new Set(steps.map((step) => step.id)).size === steps.length, "duplicate steps")
    .nullable().default(null),
  /** Shown on the first screen after sign-in, e.g. "Prepared for Valen Labs". */
  welcomeMessage: copyText(600).optional(),
}).strict();
export type OrgOnboardingPolicy = z.infer<typeof orgOnboardingPolicySchema>;

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export const orgBannerSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  tone: z.enum(["info", "warning"]),
  title: copyText(120),
  body: copyText(600).optional(),
  /** Show for this many days after the user's first sign-in. null = always. */
  showForDays: z.number().int().positive().max(365).nullable().default(null),
}).strict();

export const orgUiPolicySchema = z.object({
  /** Org name shown in "Managed by …" labels. Absent = WorkOS org name. */
  displayName: copyText(120).optional(),
  banners: z.array(orgBannerSchema).max(8).default([]),
  /** Product wording to suppress, e.g. third-party provider names. */
  hideThirdPartyProviderNames: z.boolean().default(false),
}).strict();

// ---------------------------------------------------------------------------
// Multiplayer (replaces company profiles as the editable surface; ADR-0168)
// ---------------------------------------------------------------------------

export const COMPANY_PROFILES = ["data_lab", "data_collection", "standard", "standard_raw", "regulated"] as const;
export type CompanyProfile = (typeof COMPANY_PROFILES)[number];

/** Node raw capture sources (`@ambient/multiplayer-contract` RAW_CAPTURE_SOURCES). */
export const RAW_CAPTURE_SOURCES = [
  "screen",
  "microphone",
  "system_audio",
  "keyboard_input",
  "active_app_window",
  "agent_conversation",
  "pointer_actions",
] as const;
export type RawCaptureSource = (typeof RAW_CAPTURE_SOURCES)[number];

export const MULTIPLAYER_DATA_TYPES = [
  "screenshots",
  "screen_recordings",
  "keystrokes",
  "microphone_audio",
  "system_audio",
  "active_app_window",
  "pointer_actions",
  "chunks",
  "intents",
  "memories",
  "handoffs",
] as const;
export type MultiplayerDataType = (typeof MULTIPLAYER_DATA_TYPES)[number];

/** Raw data types and the capture source that produces them. */
export const RAW_DATA_TYPE_SOURCES: Readonly<Partial<Record<MultiplayerDataType, Exclude<RawCaptureSource, "agent_conversation">>>> = {
  screenshots: "screen",
  screen_recordings: "screen",
  keystrokes: "keyboard_input",
  microphone_audio: "microphone",
  system_audio: "system_audio",
  active_app_window: "active_app_window",
  pointer_actions: "pointer_actions",
};

export const PROCESSING_MODES = ["understand", "record_only"] as const;
export type ProcessingMode = (typeof PROCESSING_MODES)[number];

export const SHARING_MODES = ["auto", "review", "off"] as const;
export type SharingMode = (typeof SHARING_MODES)[number];

/**
 * - `allowed: false`: never leaves the device.
 * - `share` default true = opt-out, default false = opt-in, locked = forced, hidden = forced and not shown.
 */
export const multiplayerDataTypePolicySchema = z.object({
  allowed: z.boolean(),
  share: managedSetting(z.boolean()).optional(),
}).strict();

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");

export const REPORT_SHARE_TARGETS = ["multiplayer", "slack"] as const;
export const orgReportsPolicySchema = z.object({
  shareTargets: uniqueList(z.enum(REPORT_SHARE_TARGETS), REPORT_SHARE_TARGETS.length).default(["multiplayer"]),
  review: managedSetting(z.enum(["review_required", "auto_publish"])).default({ mode: "default", value: "review_required" }),
  readyTime: localTime.default("08:30"),
  catchUpDays: z.number().int().min(0).max(14).default(3),
  retentionDays: z.number().int().min(1).max(90).default(7),
}).strict();
export type OrgReportsPolicy = z.infer<typeof orgReportsPolicySchema>;

export const orgMultiplayerPolicySchema = z.object({
  /** Last preset applied in the console. Informational; every field below stays editable. */
  preset: z.enum(COMPANY_PROFILES).nullable().default(null),
  /**
   * On-device processing. `understand`: the harness builds chunks, intents and
   * memories (shareable per `dataTypes`). `record_only`: raw capture only, no
   * analysis or inference (the Node's recorder profile, ADR-0167). Agent UI and
   * handoffs are separate: `features.agents` / `agentConnections`.
   */
  processing: managedSetting(z.enum(PROCESSING_MODES)).default({ mode: "locked", value: "understand" }),
  /** auto = auto_share, review = manual_share, off = no_share. */
  sharing: managedSetting(z.enum(SHARING_MODES)).default({ mode: "default", value: "review" }),
  dataTypes: z.partialRecord(z.enum(MULTIPLAYER_DATA_TYPES), multiplayerDataTypePolicySchema).default({}),
  /** Upload data captured before collection was enabled. */
  includeHistory: z.boolean().default(false),
  rawRetentionDays: z.number().int().positive().max(3650).nullable().default(null),
  /** Customer admins may set team / user type / teamspace ceilings on the Node. */
  teamOverrides: z.boolean().default(false),
  /** Desktop context loop reads org context (`multiplayer.consumeEnabled`). */
  consumeOrgContext: managedSetting(z.boolean()).optional(),
  reports: orgReportsPolicySchema.default(() => orgReportsPolicySchema.parse({})),
}).strict();
export type OrgMultiplayerPolicy = z.infer<typeof orgMultiplayerPolicySchema>;

// ---------------------------------------------------------------------------
// Pricing (ADR-0326): what this target pays on top of Alexandria's cost.
// Commercial, never sent to desktops.
// ---------------------------------------------------------------------------

/** Markup when no layer sets one. */
export const DEFAULT_MARKUP_PERCENT = 20;

export const orgPricingPolicySchema = z.object({
  /** Percent added to cost-based prices. Absent = inherited, else the product default. */
  markupPercent: z.number().min(0).max(1000).multipleOf(0.01).optional(),
}).strict();
export type OrgPricingPolicy = z.infer<typeof orgPricingPolicySchema>;

export function effectiveMarkupPercent(policy: { readonly pricing?: OrgPricingPolicy } | null | undefined): number {
  return policy?.pricing?.markupPercent ?? DEFAULT_MARKUP_PERCENT;
}

// ---------------------------------------------------------------------------
// Policy document
// ---------------------------------------------------------------------------

export const orgPolicySchema = z.object({
  schemaVersion: z.literal(ORG_POLICY_SCHEMA_VERSION),
  /** Absent key = feature default. */
  features: z.partialRecord(orgFeatureKeySchema, z.boolean()).default({}),
  inference: orgInferencePolicySchema.default(() => orgInferencePolicySchema.parse({})),
  capture: orgCapturePolicySchema.default(() => orgCapturePolicySchema.parse({})),
  agents: orgAgentsPolicySchema.default(() => orgAgentsPolicySchema.parse({})),
  onboarding: orgOnboardingPolicySchema.default(() => orgOnboardingPolicySchema.parse({})),
  ui: orgUiPolicySchema.default(() => orgUiPolicySchema.parse({})),
  /** null = the org has no Multiplayer configuration (Node keeps its stored layers). */
  multiplayer: orgMultiplayerPolicySchema.nullable().default(null),
  pricing: orgPricingPolicySchema.default({}),
}).strict().superRefine((policy, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
  const { inference, capture, agents } = policy;

  const providers = inference.allowedProviders;
  if (providers) {
    if (inference.provider && !providers.includes(inference.provider.value)) {
      issue(["inference", "provider"], "Provider must be in allowedProviders.");
    }
    inference.fallbackProviders?.forEach((provider, index) => {
      if (!providers.includes(provider)) issue(["inference", "fallbackProviders", index], "Fallback must be in allowedProviders.");
    });
  }
  for (const mode of INFERENCE_MODES) {
    if (inference.models?.[mode] && inference.modes && !inference.modes.includes(mode)) {
      issue(["inference", "models", mode], "Models are listed for a mode the organization cannot use.");
    }
  }
  inference.hiddenModes?.forEach((mode, index) => {
    if (!inference.modes || inference.modes.includes(mode)) issue(["inference", "hiddenModes", index], "A hidden mode cannot also be available.");
  });
  if (inference.mode && inference.modes && !inference.modes.includes(inference.mode.value)) {
    issue(["inference", "mode"], "The default mode must be allowed.");
  }
  for (const mode of INFERENCE_MODES) {
    const modeJobs = inference.jobs?.[mode];
    if (!modeJobs) continue;
    if (inference.modes && !inference.modes.includes(mode)) issue(["inference", "jobs", mode], "Jobs are set for a mode the organization cannot use.");
    // A job default must be allowed in its mode (when the mode has a list).
    const allowed = inference.models?.[mode];
    if (!allowed) continue;
    for (const [job, setting] of Object.entries(modeJobs)) {
      if (setting && !allowed.includes(setting.value)) issue(["inference", "jobs", mode, job], "Model must be allowed in this mode.");
    }
  }
  const models = inference.allowedModels;
  if (models) {
    for (const key of ["transcriptionModel", "retrievalModel"] as const) {
      const setting = inference[key];
      if (setting && !models.includes(setting.value)) issue(["inference", key], "Model must be in allowedModels.");
    }
  }

  const sources = capture.allowedSources;
  if (sources && capture.enabledSources) {
    capture.enabledSources.value.forEach((source, index) => {
      if (!sources.includes(source)) issue(["capture", "enabledSources", "value", index], "Source must be in allowedSources.");
    });
  }
  if (sources?.includes("pointer_actions") && policy.features.actionsCapture === false) {
    issue(["capture", "allowedSources"], "pointer_actions requires the actionsCapture feature.");
  }

  const allowedAgents = agents.allowedAgents;
  if (allowedAgents) {
    agents.autoConnectAgents.forEach((agent, index) => {
      if (!allowedAgents.includes(agent)) issue(["agents", "autoConnectAgents", index], "Agent must be in allowedAgents.");
    });
    if (agents.defaultAgent && !allowedAgents.includes(agents.defaultAgent.value)) {
      issue(["agents", "defaultAgent"], "Default agent must be in allowedAgents.");
    }
  }

  const multiplayer = policy.multiplayer;
  if (multiplayer) {
    for (const [type, setting] of Object.entries(multiplayer.dataTypes)) {
      if (setting && !setting.allowed && setting.share && setting.share.mode !== "default" && setting.share.value) {
        issue(["multiplayer", "dataTypes", type, "share"], "A data type that may not leave the device cannot be forced to share.");
      }
    }
    if (multiplayer.dataTypes.pointer_actions?.allowed && policy.features.actionsCapture === false) {
      issue(["multiplayer", "dataTypes", "pointer_actions"], "pointer_actions requires the actionsCapture feature.");
    }
    if (multiplayer.processing.value === "record_only" && multiplayer.consumeOrgContext?.value) {
      issue(["multiplayer", "consumeOrgContext"], "Record-only processing never reads org context.");
    }
  }

  for (const feature of ORG_FEATURES) {
    if (!feature.requires) continue;
    if (policy.features[feature.key] === true && !orgFeatureEnabled(policy, feature.requires)) {
      issue(["features", feature.key], `Requires ${feature.requires}.`);
    }
  }
});

export type OrgPolicy = z.infer<typeof orgPolicySchema>;
export type OrgPolicyInput = z.input<typeof orgPolicySchema>;

export function emptyOrgPolicy(): OrgPolicy {
  return orgPolicySchema.parse({ schemaVersion: ORG_POLICY_SCHEMA_VERSION });
}

export function orgFeatureEnabled(policy: Pick<OrgPolicy, "features">, key: OrgFeatureKey): boolean {
  const definition = orgFeatureDefinition(key);
  const enabled = policy.features[key] ?? definition.defaultEnabled;
  if (!enabled) return false;
  return definition.requires ? orgFeatureEnabled(policy, definition.requires) : true;
}

/**
 * WorkOS slugs outside the feature registry that a published policy now owns
 * (capture privacy). With a policy they are emitted from `capture`, never
 * passed through from WorkOS.
 */
export const ORG_POLICY_CONTROLLED_SLUGS = {
  textRedactionDefaultOff: "text-redaction-default-off",
  keyboardAllowUnknown: "keyboard-capture-allow-unknown",
  pointerAllowUnknown: "pointer-capture-allow-unknown",
} as const;

type SlugPolicy = Pick<OrgPolicy, "features"> & { readonly capture?: Pick<OrgCapturePolicy, "redactionLevel" | "allowUnknownFocus"> };

/** Legacy WorkOS slugs a published policy turns on, for desktop builds that predate policies. */
export function orgPolicyLegacyFeatureSlugs(policy: SlugPolicy): string[] {
  const slugs = ORG_FEATURES.filter((feature) => orgFeatureEnabled(policy, feature.key)).map((feature) => feature.legacySlug);
  const capture = policy.capture;
  if (capture) {
    // Older desktops only know "redaction defaults off"; any `off` maps to it.
    if (capture.redactionLevel?.value === "off") slugs.push(ORG_POLICY_CONTROLLED_SLUGS.textRedactionDefaultOff);
    if (capture.allowUnknownFocus.keyboard) slugs.push(ORG_POLICY_CONTROLLED_SLUGS.keyboardAllowUnknown);
    if (capture.allowUnknownFocus.pointer) slugs.push(ORG_POLICY_CONTROLLED_SLUGS.pointerAllowUnknown);
  }
  return slugs.sort();
}

/**
 * Effective flag slugs for one organization: with a policy, the policy decides
 * every registry slug (and the capture slugs it owns); other WorkOS slugs pass
 * through unchanged. Without one, the WorkOS slugs apply as-is. Cloud (legacy
 * bridging) and the desktop (fresh policy over a cached session) share this rule.
 */
export function orgPolicyFeatureSlugs(workosSlugs: readonly string[], policy: SlugPolicy | null): string[] {
  if (!policy) return [...new Set(workosSlugs)].sort();
  const owned = new Set<string>(ORG_FEATURES.map((feature) => feature.legacySlug));
  if (policy.capture) for (const slug of Object.values(ORG_POLICY_CONTROLLED_SLUGS)) owned.add(slug);
  return [...new Set([
    ...workosSlugs.filter((slug) => !owned.has(slug)),
    ...orgPolicyLegacyFeatureSlugs(policy),
  ])].sort();
}

// ---------------------------------------------------------------------------
// Multiplayer presets and Node compilation
// ---------------------------------------------------------------------------

type DataTypes = OrgMultiplayerPolicy["dataTypes"];
const RAW_TYPES = ["screenshots", "screen_recordings", "keystrokes", "microphone_audio", "system_audio", "active_app_window", "pointer_actions"] as const;

function dataTypes(allowed: readonly MultiplayerDataType[], share: Managed<boolean>): DataTypes {
  const result: Partial<Record<MultiplayerDataType, z.infer<typeof multiplayerDataTypePolicySchema>>> = {};
  for (const type of MULTIPLAYER_DATA_TYPES) {
    result[type] = allowed.includes(type) ? { allowed: true, share: { ...share } } : { allowed: false };
  }
  return result;
}

/**
 * A full, editable Multiplayer section that reproduces a company profile's
 * compiled behaviour with its default settings (multiplayer-contract
 * `COMPANY_PROFILE_DESCRIPTORS` + `compileCompanyProfileLayers`). Presets only
 * fill defaults.
 */
export function multiplayerPresetDefaults(profile: CompanyProfile): OrgMultiplayerPolicy {
  const reports = (shareTargets: ("multiplayer" | "slack")[]) => orgReportsPolicySchema.parse({ shareTargets });
  const base = { preset: profile, includeHistory: false, rawRetentionDays: null, teamOverrides: false } as const;
  switch (profile) {
    case "data_lab": return orgMultiplayerPolicySchema.parse({
      ...base,
      processing: { mode: "locked", value: "record_only" },
      sharing: { mode: "locked", value: "auto" },
      dataTypes: dataTypes(RAW_TYPES, { mode: "locked", value: true }),
      consumeOrgContext: { mode: "hidden", value: false },
      reports: reports([]),
    });
    case "data_collection": return orgMultiplayerPolicySchema.parse({
      ...base,
      processing: { mode: "locked", value: "understand" },
      // collectionEnabled defaults off on the Node: nothing leaves until an operator turns it on.
      sharing: { mode: "locked", value: "off" },
      dataTypes: dataTypes([...RAW_TYPES, "chunks", "intents", "memories"], { mode: "locked", value: true }),
      reports: reports([]),
    });
    case "standard": return orgMultiplayerPolicySchema.parse({
      ...base,
      processing: { mode: "locked", value: "understand" },
      sharing: { mode: "default", value: "review" },
      // Raw recordings stay on the device (egress = reports only).
      dataTypes: dataTypes(["chunks", "intents", "memories", "handoffs"], { mode: "default", value: false }),
      reports: reports(["multiplayer"]),
    });
    case "standard_raw": return orgMultiplayerPolicySchema.parse({
      ...base,
      processing: { mode: "locked", value: "understand" },
      sharing: { mode: "default", value: "review" },
      dataTypes: dataTypes([...RAW_TYPES, "chunks", "intents", "memories", "handoffs"], { mode: "default", value: false }),
      reports: reports(["multiplayer"]),
    });
    case "regulated": return orgMultiplayerPolicySchema.parse({
      ...base,
      processing: { mode: "locked", value: "understand" },
      sharing: { mode: "default", value: "review" },
      // Governed by the Node's stored layers; these are display defaults only.
      dataTypes: dataTypes(["chunks", "intents", "memories", "handoffs"], { mode: "default", value: false }),
      teamOverrides: true,
      reports: reports(["multiplayer"]),
    });
  }
}

/** Raw sources the section lets leave the device. */
export function multiplayerRawSources(multiplayer: Pick<OrgMultiplayerPolicy, "dataTypes">): RawCaptureSource[] {
  const sources = new Set<RawCaptureSource>();
  for (const type of RAW_TYPES) {
    const source = RAW_DATA_TYPE_SOURCES[type];
    if (source && multiplayer.dataTypes[type]?.allowed) sources.add(source);
  }
  return RAW_CAPTURE_SOURCES.filter((source) => sources.has(source));
}

const DERIVED_TYPES = ["chunks", "intents", "memories"] as const;

/** Company profile the section behaves like, when no preset is recorded. */
export function inferCompanyProfile(multiplayer: OrgMultiplayerPolicy): CompanyProfile {
  if (multiplayer.teamOverrides) return "regulated";
  if (multiplayer.processing.value === "record_only") return "data_lab";
  const raw = multiplayerRawSources(multiplayer).length > 0;
  const reportsOn = multiplayer.reports.shareTargets.includes("multiplayer");
  const derived = DERIVED_TYPES.some((type) => multiplayer.dataTypes[type]?.allowed);
  if (raw && !reportsOn && derived) return "data_collection";
  if (raw && reportsOn) return "standard_raw";
  return "standard";
}

/**
 * Best-effort compile into multiplayer-server's `setCompanyProfileRequestSchema`
 * shape (minus `updatedBy`) for the Cloud → Node push. The Node keeps
 * enforcing the compiled profile.
 */
export function compileMultiplayerToCompanyProfile(
  multiplayer: OrgMultiplayerPolicy,
  appRules: readonly OrgAppRule[] = [],
): {
  readonly profile: CompanyProfile;
  readonly settings: {
    readonly rawSources: RawCaptureSource[];
    readonly blockList: BlockRule[];
    readonly reportsEnabled: boolean;
    readonly collectionEnabled: boolean;
    readonly uploadExistingLocalData: boolean;
    readonly rawRetentionDays: number | null;
  };
} {
  const profile = multiplayer.preset ?? inferCompanyProfile(multiplayer);
  return {
    profile,
    settings: {
      rawSources: multiplayerRawSources(multiplayer),
      // Node block list = the org's enforced exclusions.
      blockList: appRules.filter((rule) => rule.list === "excluded" && rule.mode === "locked")
        .slice(0, 256).map((rule) => ({ target: rule.target, pattern: rule.pattern })),
      reportsEnabled: multiplayer.sharing.value !== "off" && multiplayer.reports.shareTargets.includes("multiplayer"),
      collectionEnabled: multiplayer.sharing.value === "auto",
      uploadExistingLocalData: multiplayer.includeHistory,
      rawRetentionDays: multiplayer.rawRetentionDays,
    },
  };
}

// ---------------------------------------------------------------------------
// Versioning and audit
// ---------------------------------------------------------------------------

export const orgPolicyActorSchema = z.object({
  kind: z.enum(["operator", "agent", "system"]),
  /** WorkOS user id (operator/agent acting for an operator) or a system name. */
  id: shortId,
  email: z.string().trim().max(320).nullable(),
  /** MCP client name when kind = agent. */
  client: z.string().trim().max(200).nullable().default(null),
}).strict();
export type OrgPolicyActor = z.infer<typeof orgPolicyActorSchema>;

export const orgPolicyVersionSchema = z.object({
  workosOrganizationId: shortId,
  version: z.number().int().positive(),
  policy: orgPolicySchema,
  reason: z.string().trim().min(1).max(1000),
  actor: orgPolicyActorSchema,
  publishedAt: z.iso.datetime({ offset: true }),
  /** Version this one was restored from, when published by rollback. */
  restoredFromVersion: z.number().int().positive().nullable(),
}).strict();
export type OrgPolicyVersion = z.infer<typeof orgPolicyVersionSchema>;

export const orgPolicyDraftSchema = z.object({
  workosOrganizationId: shortId,
  /** Published version this draft was started from (null = none published yet). */
  baseVersion: z.number().int().positive().nullable(),
  /** Increments on every draft write; used for optimistic concurrency. */
  revision: z.number().int().positive(),
  policy: orgPolicySchema,
  updatedBy: orgPolicyActorSchema,
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type OrgPolicyDraft = z.infer<typeof orgPolicyDraftSchema>;

/** What the desktop receives (`GET /v1/org-policy`). */
export const desktopOrgPolicySchema = z.object({
  workosOrganizationId: shortId,
  organizationName: z.string().max(200),
  version: z.number().int().positive(),
  publishedAt: z.iso.datetime({ offset: true }),
  policy: orgPolicySchema,
}).strict();
export type DesktopOrgPolicy = z.infer<typeof desktopOrgPolicySchema>;

// ---------------------------------------------------------------------------
// Global controls (desktop wire). Operator shapes and the resolver live in
// global-controls.ts; these are here so the desktop response stays one schema.
// ---------------------------------------------------------------------------

/** Model ids as the inference routes accept them. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;

/** What a global control turns off. Features must be registry entries with `globalControl`. */
export const globalControlTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("provider"), id: inferenceProviderSchema }).strict(),
  z.object({ kind: z.literal("model"), id: z.string().regex(MODEL_ID_PATTERN) }).strict(),
  z.object({
    kind: z.literal("feature"),
    key: orgFeatureKeySchema.refine((key) => orgFeatureDefinition(key).globalControl === true, "This feature cannot be turned off globally."),
  }).strict(),
]);
export type GlobalControlTarget = z.infer<typeof globalControlTargetSchema>;
export type GlobalControlKind = GlobalControlTarget["kind"];
export const GLOBAL_CONTROL_KINDS = ["provider", "model", "feature"] as const satisfies readonly GlobalControlKind[];

/** Wire / storage id of a target (`id` for providers and models, `key` for features). */
export function globalControlTargetId(target: GlobalControlTarget): string {
  return target.kind === "feature" ? target.key : target.id;
}

export function globalControlTargetKey(target: GlobalControlTarget): string {
  return `${target.kind}:${globalControlTargetId(target)}`;
}

/** Text shown to people while the control is on. */
export const globalControlNoticeSchema = z.string().trim().min(1).max(240);

/**
 * One global kill as a desktop receives it: already resolved for the signed-in
 * organization (no scope, never another organization's id).
 */
export const desktopGlobalControlSchema = z.object({
  target: globalControlTargetSchema,
  notice: globalControlNoticeSchema.nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export type DesktopGlobalControl = z.infer<typeof desktopGlobalControlSchema>;

/**
 * `GET /v1/org-policy` body. `orgPolicy` null = personal session or no
 * published policy. `globalControls` = Alexandria-wide kills that apply to
 * this session (restrict only; applied on top of the policy or the defaults).
 */
export const desktopOrgPolicyResponseSchema = z.object({
  orgPolicy: desktopOrgPolicySchema.nullable(),
  globalControls: z.array(desktopGlobalControlSchema).max(500).default([]),
}).strict();
export type DesktopOrgPolicyResponse = z.infer<typeof desktopOrgPolicyResponseSchema>;

export const ORG_POLICY_AUDIT_ACTIONS = ["draft_saved", "draft_discarded", "published", "rolled_back", "node_sync"] as const;

export const orgPolicyAuditEntrySchema = z.object({
  id: shortId,
  workosOrganizationId: shortId,
  action: z.enum(ORG_POLICY_AUDIT_ACTIONS),
  actor: orgPolicyActorSchema,
  reason: z.string().nullable(),
  /** Draft or published state before / after the change (null when absent). */
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  requestId: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();
export type OrgPolicyAuditEntry = z.infer<typeof orgPolicyAuditEntrySchema>;
