import { z } from "zod";

// Inference catalog and plan (ADR-0297). Alexandria operators edit one global
// catalog in the Alexandria console: which models each inference mode offers,
// where each model runs, and the default model for every job. Organization
// policy narrows it (allowed modes, models per mode, per-job default and
// visibility). Cloud resolves both into the plan a signed-in desktop receives
// and enforces the same plan when it signs an inference grant. Routes are
// chosen from code-defined, tested executors; the catalog only picks among them.

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Inference modes. `zero-retention` is the Node's `plaintext` inference mode. */
export const INFERENCE_MODES = ["confidential", "zero-retention"] as const;
export type InferenceMode = (typeof INFERENCE_MODES)[number];
export const inferenceModeSchema = z.enum(INFERENCE_MODES);

export const INFERENCE_MODE_LABELS: Readonly<Record<InferenceMode, string>> = {
  confidential: "Alexandria Confidential Inference",
  "zero-retention": "Alexandria Zero Data Retention",
};

/** The Node/bootstrap `inferenceMode` value for an inference mode. */
export function inferenceModeFromNodeMode(nodeMode: "confidential" | "plaintext"): InferenceMode {
  return nodeMode === "plaintext" ? "zero-retention" : "confidential";
}

/** Work a model is chosen for. Each job has one default and optional user choices. */
export const INFERENCE_JOBS = [
  "screen",
  "memory",
  "intent",
  "redaction",
  "transcription",
  "retrieval",
  "live_reasoning",
  "deep_reasoning",
  "consolidation",
  "look",
  "daily_report",
] as const;
export type InferenceJob = (typeof INFERENCE_JOBS)[number];
export const inferenceJobSchema = z.enum(INFERENCE_JOBS);

export const INFERENCE_MODEL_KINDS = ["chat", "transcription", "embedding"] as const;
export type InferenceModelKind = (typeof INFERENCE_MODEL_KINDS)[number];

export interface InferenceJobDefinition {
  readonly job: InferenceJob;
  readonly title: string;
  readonly kind: InferenceModelKind;
  /** Only models with image input can serve this job. */
  readonly requiresVision?: true;
}

export const INFERENCE_JOB_DEFINITIONS: readonly InferenceJobDefinition[] = [
  { job: "screen", title: "Screen reading", kind: "chat", requiresVision: true },
  { job: "memory", title: "Memory processing", kind: "chat" },
  { job: "intent", title: "Intent", kind: "chat" },
  { job: "redaction", title: "Redaction", kind: "chat" },
  { job: "transcription", title: "Transcription", kind: "transcription" },
  { job: "retrieval", title: "Retrieval", kind: "embedding" },
  { job: "live_reasoning", title: "Live reasoning", kind: "chat" },
  { job: "deep_reasoning", title: "Deep reasoning", kind: "chat" },
  { job: "consolidation", title: "Memory consolidation", kind: "chat" },
  { job: "look", title: "Look", kind: "chat", requiresVision: true },
  { job: "daily_report", title: "Daily report", kind: "chat" },
];

export function inferenceJobDefinition(job: InferenceJob): InferenceJobDefinition {
  return INFERENCE_JOB_DEFINITIONS.find((definition) => definition.job === job)!;
}

/** Same values as the org policy's managed-setting modes. */
export const INFERENCE_VISIBILITIES = ["default", "locked", "hidden"] as const;
export type InferenceVisibility = (typeof INFERENCE_VISIBILITIES)[number];

export const INFERENCE_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;
export const inferenceModelIdSchema = z.string().regex(INFERENCE_MODEL_ID_PATTERN);

const uniqueIds = (max: number) => z.array(inferenceModelIdSchema).max(max)
  .refine((list) => new Set(list).size === list.length, "duplicate model ids");

// ---------------------------------------------------------------------------
// Catalog (operator-edited, versioned in Cloud)
// ---------------------------------------------------------------------------

/** Executors are code; a route only selects one. Regions are AWS region ids. */
export const inferenceRouteSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("bedrock"), region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/) }).strict(),
  z.object({ provider: z.literal("openrouter") }).strict(),
  z.object({ provider: z.literal("tinfoil") }).strict(),
  z.object({ provider: z.literal("alexandria") }).strict(),
]);
export type InferenceRoute = z.infer<typeof inferenceRouteSchema>;
export type InferenceRouteProvider = InferenceRoute["provider"];

/** Providers that may serve each mode. Provider-readable executors never serve confidential inference. */
export const INFERENCE_MODE_PROVIDERS: Readonly<Record<InferenceMode, readonly InferenceRouteProvider[]>> = {
  confidential: ["tinfoil", "alexandria"],
  "zero-retention": ["bedrock", "openrouter"],
};

export const inferenceModelCapabilitiesSchema = z.object({
  vision: z.boolean().default(false),
  tools: z.boolean().default(false),
  reasoning: z.boolean().default(false),
  contextTokens: z.number().int().positive().max(10_000_000).optional(),
  maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
}).strict();
export type InferenceModelCapabilities = z.infer<typeof inferenceModelCapabilitiesSchema>;

export const inferenceCatalogModelSchema = z.object({
  /** Proper id naming the model that runs (`gemma-4-31b`). Current clients send only these. */
  id: inferenceModelIdSchema,
  /** What people see. */
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  kind: z.enum(INFERENCE_MODEL_KINDS),
  capabilities: inferenceModelCapabilitiesSchema.default({ vision: false, tools: false, reasoning: false }),
  /**
   * Older ids released desktops still send for this model (`gemma4-31b`,
   * `glm-5-3-flash`). They are accepted, run and bill as this model, and are
   * never offered to current clients. The first one is the id released
   * desktops are told to use; the others are remapped to it.
   */
  aliases: uniqueIds(32).default([]),
}).strict();
export type InferenceCatalogModel = z.infer<typeof inferenceCatalogModelSchema>;

export const inferenceCatalogOfferSchema = z.object({
  model: inferenceModelIdSchema,
  route: inferenceRouteSchema,
  /** Route-specific label, when the route runs a different model than `label` names. */
  label: z.string().trim().min(1).max(80).optional(),
}).strict();
export type InferenceCatalogOffer = z.infer<typeof inferenceCatalogOfferSchema>;

const jobRecord = <T extends z.ZodType>(value: T) => z.object(
  Object.fromEntries(INFERENCE_JOBS.map((job) => [job, value.optional()])) as Record<InferenceJob, z.ZodOptional<T>>,
).strict();

export const inferenceCatalogModeSchema = z.object({
  offers: z.array(inferenceCatalogOfferSchema).min(1).max(64),
  defaults: jobRecord(inferenceModelIdSchema),
  fallbacks: jobRecord(uniqueIds(8)).default({}),
}).strict();
export type InferenceCatalogMode = z.infer<typeof inferenceCatalogModeSchema>;

/** Temporary per-Node routing while installations move between executors. */
export const inferenceRouteOverrideSchema = z.object({
  installationId: z.string().trim().min(1).max(200),
  mode: inferenceModeSchema,
  models: uniqueIds(64).min(1),
  route: inferenceRouteSchema,
  labels: z.record(inferenceModelIdSchema, z.string().trim().min(1).max(80)).optional(),
}).strict();
export type InferenceRouteOverride = z.infer<typeof inferenceRouteOverrideSchema>;

export const inferenceCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  models: z.array(inferenceCatalogModelSchema).min(1).max(128),
  modes: z.object({
    confidential: inferenceCatalogModeSchema.optional(),
    "zero-retention": inferenceCatalogModeSchema.optional(),
  }).strict(),
  routeOverrides: z.array(inferenceRouteOverrideSchema).max(64).default([]),
}).strict().superRefine((catalog, context) => {
  const models = new Map<string, InferenceCatalogModel>();
  catalog.models.forEach((model, index) => {
    if (models.has(model.id)) context.addIssue({ code: "custom", path: ["models", index, "id"], message: "Duplicate model id." });
    models.set(model.id, model);
  });
  const aliasOwners = new Map<string, string>();
  catalog.models.forEach((model, index) => {
    for (const alias of model.aliases) {
      if (models.has(alias) || aliasOwners.has(alias)) {
        context.addIssue({ code: "custom", path: ["models", index, "aliases"], message: `${alias} already names another model.` });
      }
      aliasOwners.set(alias, model.id);
    }
  });
  for (const mode of INFERENCE_MODES) {
    const entry = catalog.modes[mode];
    if (!entry) continue;
    const offered = new Set<string>();
    entry.offers.forEach((offer, index) => {
      if (!models.has(offer.model)) context.addIssue({ code: "custom", path: ["modes", mode, "offers", index, "model"], message: "Unknown model." });
      if (offered.has(offer.model)) context.addIssue({ code: "custom", path: ["modes", mode, "offers", index, "model"], message: "Model offered twice." });
      if (!INFERENCE_MODE_PROVIDERS[mode].includes(offer.route.provider)) {
        context.addIssue({ code: "custom", path: ["modes", mode, "offers", index, "route"], message: `${offer.route.provider} cannot serve ${mode}.` });
      }
      offered.add(offer.model);
    });
    for (const job of INFERENCE_JOBS) {
      const definition = inferenceJobDefinition(job);
      const ids = [entry.defaults[job], ...(entry.fallbacks[job] ?? [])].filter((id): id is string => id !== undefined);
      for (const id of ids) {
        const model = models.get(id);
        if (!offered.has(id) || !model || !servesJob(model, definition)) {
          context.addIssue({ code: "custom", path: ["modes", mode, "defaults", job], message: `${id} cannot serve ${job} in ${mode}.` });
        }
      }
    }
  }
  catalog.routeOverrides.forEach((override, index) => {
    if (!INFERENCE_MODE_PROVIDERS[override.mode].includes(override.route.provider)) {
      context.addIssue({ code: "custom", path: ["routeOverrides", index, "route"], message: `${override.route.provider} cannot serve ${override.mode}.` });
    }
  });
});
export type InferenceCatalog = z.infer<typeof inferenceCatalogSchema>;

/** The catalog model an id names: its own id, or one of its released-client aliases. */
export function inferenceCatalogModel(catalog: InferenceCatalog, id: string): InferenceCatalogModel | null {
  return catalog.models.find((model) => model.id === id || model.aliases.includes(id)) ?? null;
}

export function servesJob(model: InferenceCatalogModel, definition: InferenceJobDefinition): boolean {
  return model.kind === definition.kind && (!definition.requiresVision || model.capabilities.vision);
}

/** Published catalog revision as stored and served to the console. */
export const inferenceCatalogVersionSchema = z.object({
  version: z.number().int().positive(),
  catalog: inferenceCatalogSchema,
  publishedBy: z.string().max(320),
  publishedAt: z.iso.datetime({ offset: true }),
  note: z.string().max(500).optional(),
}).strict();
export type InferenceCatalogVersion = z.infer<typeof inferenceCatalogVersionSchema>;

/** Where a model runs for one Node, after per-installation overrides. */
export function inferenceRouteFor(
  catalog: InferenceCatalog,
  input: { readonly mode: InferenceMode; readonly modelId: string; readonly installationId: string },
): { readonly route: InferenceRoute; readonly label: string | null; readonly modelId: string } | null {
  const model = inferenceCatalogModel(catalog, input.modelId);
  const offer = model && catalog.modes[input.mode]?.offers.find((entry) => entry.model === model.id);
  if (!model || !offer) return null;
  const override = catalog.routeOverrides.find((entry) =>
    entry.installationId === input.installationId && entry.mode === input.mode && entry.models.includes(model.id));
  if (override) return { route: override.route, label: override.labels?.[model.id] ?? null, modelId: model.id };
  return { route: offer.route, label: offer.label ?? null, modelId: model.id };
}

// ---------------------------------------------------------------------------
// Prices (operator-edited, immutable versions in Cloud)
// ---------------------------------------------------------------------------

const micros = z.union([z.string().regex(/^(0|[1-9][0-9]{0,18})$/), z.number().int().nonnegative()]);
const positiveMicros = micros.refine((value) => BigInt(value) > 0n, "Value must be positive");

export const INFERENCE_PRICE_ROUTES = ["/v1/chat/completions", "/v1/responses", "/v1/audio/transcriptions", "/v1/embeddings"] as const;

/**
 * Only for this executor (ADR-0313). One id can run on several executors once
 * a Node serves both modes (Tinfoil and OpenRouter both bill the client id),
 * at different costs. Absent = every executor; a provider row wins.
 */
const priceProvider = z.enum(["bedrock", "openrouter", "tinfoil", "alexandria"]).optional();

/** Key that must be unique within a price version. */
export function inferencePriceRowKey(row: { readonly route: string; readonly modelId: string; readonly provider?: string }): string {
  return `${row.route} ${row.provider ?? "*"} ${row.modelId}`;
}

/**
 * One price row. `modelId` is the model that executes (a Bedrock native id, or
 * the client id for other executors), so one row prices every alias of it.
 * Same shapes `INFERENCE_PRICING_CATALOG_JSON` accepted.
 */
export const inferencePriceRowSchema = z.union([
  z.object({
    route: z.enum(INFERENCE_PRICE_ROUTES),
    modelId: inferenceModelIdSchema,
    billing: z.literal("per_request"),
    provider: priceProvider,
    requestMicros: positiveMicros,
    reservationMicros: positiveMicros.optional(),
    inputMicrosPerMillion: z.union([z.literal("0"), z.literal(0)]).optional(),
    outputMicrosPerMillion: z.union([z.literal("0"), z.literal(0)]).optional(),
  }).strict(),
  z.object({
    route: z.literal("/v1/audio/transcriptions"),
    modelId: inferenceModelIdSchema,
    billing: z.literal("audio_seconds"),
    provider: priceProvider,
    audioMicrosPerMinute: positiveMicros,
    reservationMicros: positiveMicros,
  }).strict(),
  z.object({
    route: z.enum(INFERENCE_PRICE_ROUTES),
    modelId: inferenceModelIdSchema,
    billing: z.literal("tokens").optional(),
    provider: priceProvider,
    inputMicrosPerMillion: micros,
    cacheInputMicrosPerMillion: micros.optional(),
    outputMicrosPerMillion: micros,
    reservationMicros: positiveMicros,
  }).strict(),
]);
export type InferencePriceRow = z.infer<typeof inferencePriceRowSchema>;

export const INFERENCE_PRICE_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

/**
 * What a version's rows mean (ADR-0326).
 * - `customer` (absent on older versions): what customers pay. No markup.
 * - `cost`: what Alexandria pays the provider. Customers pay it plus the markup
 *   their organization, plan or defaults layer sets (`pricing.markupPercent`).
 */
export const INFERENCE_PRICE_BASES = ["customer", "cost"] as const;
export type InferencePriceBasis = (typeof INFERENCE_PRICE_BASES)[number];

/** A row's rates without its route, executor and model: one price, any of the three billings. */
export const inferencePriceRatesSchema = z.union([
  z.object({ billing: z.literal("tokens"), inputMicrosPerMillion: micros, cacheInputMicrosPerMillion: micros.optional(), outputMicrosPerMillion: micros, reservationMicros: positiveMicros }).strict(),
  z.object({ billing: z.literal("per_request"), requestMicros: positiveMicros, reservationMicros: positiveMicros.optional() }).strict(),
  z.object({ billing: z.literal("audio_seconds"), audioMicrosPerMinute: positiveMicros, reservationMicros: positiveMicros }).strict(),
]);
export type InferencePriceRates = z.infer<typeof inferencePriceRatesSchema>;

/** A provider's list price for one model it runs (e.g. Amazon Bedrock in eu-central-1). */
export const providerPriceSchema = z.object({
  provider: z.enum(["bedrock", "openrouter", "tinfoil", "alexandria"]),
  /** Bedrock region; absent for providers without regions. */
  region: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  /** The id the provider runs (a Bedrock native id, or the client id elsewhere). */
  modelId: inferenceModelIdSchema,
  rates: inferencePriceRatesSchema,
}).strict();
export type ProviderPrice = z.infer<typeof providerPriceSchema>;

/** Where a catalog model's cost in one mode comes from: its provider's list price, or a custom price. */
export const modelPriceSourceSchema = z.object({
  mode: inferenceModeSchema,
  model: inferenceModelIdSchema,
  source: z.enum(["provider", "custom"]),
  /** Required for `custom`. */
  rates: inferencePriceRatesSchema.optional(),
}).strict().refine((value) => value.source !== "custom" || value.rates !== undefined, { message: "A custom price needs its rates.", path: ["rates"] });
export type ModelPriceSource = z.infer<typeof modelPriceSourceSchema>;

/**
 * A price version never changes once created. Identities sign the version that
 * was active when they were issued; accounting reads that exact version.
 */
export const inferencePriceVersionSchema = z.object({
  version: z.string().regex(INFERENCE_PRICE_VERSION_PATTERN),
  /** Compiled rows Cloud charges by; the console builds them from the inputs below. */
  prices: z.array(inferencePriceRowSchema).max(512),
  note: z.string().max(500).optional(),
  basis: z.enum(INFERENCE_PRICE_BASES).optional(),
  /** Editor inputs (ADR-0326): provider list prices, and where each model's cost comes from. */
  providerPrices: z.array(providerPriceSchema).max(512).optional(),
  modelPrices: z.array(modelPriceSourceSchema).max(512).optional(),
}).strict().superRefine((value, context) => {
  // A version built from model sources may arrive without rows: Cloud compiles them.
  if (value.prices.length === 0 && !value.modelPrices?.length) context.addIssue({ code: "custom", path: ["prices"], message: "A price version needs prices." });
  const seen = new Set<string>();
  value.prices.forEach((row, index) => {
    const key = inferencePriceRowKey(row);
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["prices", index], message: `Duplicate price for ${key}.` });
    seen.add(key);
  });
});
export type InferencePriceVersion = z.infer<typeof inferencePriceVersionSchema>;

export const inferencePriceVersionRecordSchema = z.object({
  version: z.string().regex(INFERENCE_PRICE_VERSION_PATTERN),
  prices: z.array(inferencePriceRowSchema),
  note: z.string().max(500).optional(),
  basis: z.enum(INFERENCE_PRICE_BASES).optional(),
  providerPrices: z.array(providerPriceSchema).optional(),
  modelPrices: z.array(modelPriceSourceSchema).optional(),
  createdBy: z.string().max(320),
  createdAt: z.iso.datetime({ offset: true }),
  /** Set while this is the version new identities receive. */
  activatedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export type InferencePriceVersionRecord = z.infer<typeof inferencePriceVersionRecordSchema>;

// ---------------------------------------------------------------------------
// Organization inference settings (the `inference` section of org policy)
// ---------------------------------------------------------------------------

export interface OrgManagedValue<T> { readonly mode: InferenceVisibility; readonly value: T }

/** The narrowing an organization applies. Absent or null = everything the catalog offers. */
export interface OrgInferenceSettings {
  readonly modes?: readonly InferenceMode[] | null;
  /** The mode people use and whether they may switch (ADR-0313). Absent = the Node's default mode, switchable. */
  readonly mode?: OrgManagedValue<InferenceMode>;
  readonly models?: Partial<Record<InferenceMode, readonly string[] | null>>;
  /** Per mode, per job: the default model and its visibility. */
  readonly jobs?: Partial<Record<InferenceMode, Partial<Record<InferenceJob, OrgManagedValue<string>>>>>;
  /** Modes the account never sees (ADR-0324): left out of `modes` entirely. */
  readonly hiddenModes?: readonly InferenceMode[];
  /** Shown next to a mode the account cannot use (ADR-0324), e.g. why Confidential is unavailable. */
  readonly modeNotices?: Partial<Record<InferenceMode, string>>;
  /** Jobs that run only on the person's own ChatGPT or Claude: no Alexandria model is offered for them (ADR-0324). */
  readonly agentOnlyJobs?: readonly InferenceJob[];
}

// ---------------------------------------------------------------------------
// Plan (what a signed-in desktop receives, `GET /v1/inference/plan`)
// ---------------------------------------------------------------------------

export const inferencePlanModelSchema = z.object({
  id: inferenceModelIdSchema,
  label: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  kind: z.enum(INFERENCE_MODEL_KINDS),
  capabilities: inferenceModelCapabilitiesSchema,
}); // Not strict: desktops ignore fields a newer Cloud adds.
export type InferencePlanModel = z.infer<typeof inferencePlanModelSchema>;

export const inferencePlanJobSchema = z.object({
  /** Used unless the person picked an allowed choice. */
  default: inferenceModelIdSchema,
  /** What the person may pick; only the default when locked or hidden. */
  choices: uniqueIds(64).min(1),
  /** Tried in order when the chosen model is unavailable. */
  fallbacks: uniqueIds(8),
  /** `hidden`: no picker. `locked`: shown, not changeable. */
  visibility: z.enum(INFERENCE_VISIBILITIES),
});
export type InferencePlanJob = z.infer<typeof inferencePlanJobSchema>;

/** Plan shapes strip unknown fields instead of refusing them, so a newer Cloud can add fields or jobs. */
const planJobRecord = <T extends z.ZodType>(value: T) => z.object(
  Object.fromEntries(INFERENCE_JOBS.map((job) => [job, value.optional()])) as Record<InferenceJob, z.ZodOptional<T>>,
);

/** Models and jobs of one mode. */
export const inferencePlanModeSchema = z.object({
  models: z.array(inferencePlanModelSchema).max(128),
  jobs: planJobRecord(inferencePlanJobSchema),
});
export type InferencePlanMode = z.infer<typeof inferencePlanModeSchema>;

export const inferencePlanSchema = z.object({
  schemaVersion: z.literal(1),
  /** Changes whenever anything in the plan changes. */
  revision: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  /** The account's default mode; `models` and `jobs` are this mode's. */
  mode: inferenceModeSchema,
  modes: z.array(z.object({
    id: inferenceModeSchema,
    label: z.string().min(1).max(80),
    /** This account may use it: its Node serves it, the organization allows it, and the choice is not locked to another mode. */
    allowed: z.boolean(),
    /** The default mode. */
    current: z.boolean(),
    /** Why the mode is unavailable, in the account's words (ADR-0324). Absent from older Clouds. */
    notice: z.string().max(300).optional(),
  })).max(INFERENCE_MODES.length),
  /**
   * Which mode the account uses (ADR-0313): the default, the modes a person
   * may switch to, and whether the organization shows, locks or hides the
   * choice. Absent from Clouds before ADR-0313 and when no mode is usable.
   */
  modeChoice: z.object({
    default: inferenceModeSchema,
    choices: z.array(inferenceModeSchema).min(1).max(INFERENCE_MODES.length),
    visibility: z.enum(INFERENCE_VISIBILITIES),
  }).optional(),
  models: z.array(inferencePlanModelSchema).max(128),
  jobs: planJobRecord(inferencePlanJobSchema),
  /** Models and jobs for every mode in `modeChoice.choices`. */
  byMode: z.object({
    confidential: inferencePlanModeSchema.optional(),
    "zero-retention": inferencePlanModeSchema.optional(),
  }).optional(),
  /**
   * Jobs this account runs only on its own ChatGPT or Claude (ADR-0324). They
   * have no entry in `jobs`; the desktop must route them to a connected
   * subscription. Absent from older Clouds = none.
   */
  agentOnlyJobs: z.array(z.enum(INFERENCE_JOBS)).max(INFERENCE_JOBS.length).optional(),
});
export type InferencePlan = z.infer<typeof inferencePlanSchema>;

export interface ResolvedInferencePlan {
  readonly plan: InferencePlan;
  /** Ids Cloud accepts in the default mode: proper ids and their released-client aliases. */
  readonly accepted: ReadonlySet<string>;
  /** Ids Cloud accepts in each mode this account may use; a mode absent here is refused. */
  readonly acceptedByMode: Readonly<Partial<Record<InferenceMode, ReadonlySet<string>>>>;
}

/**
 * Resolve the plan for one account: the modes it may use (its Node's modes,
 * narrowed by the organization), and for each the catalog's offers narrowed by
 * organization settings and global kills. Pure; Cloud uses the same result to
 * answer the desktop and to sign grants.
 */
export function resolveInferencePlan(input: {
  readonly catalog: InferenceCatalog;
  /** The Node's default mode: what released desktops use. */
  readonly mode: InferenceMode;
  /** Every mode the Node serves (ADR-0313). Absent = only `mode`. */
  readonly modes?: readonly InferenceMode[];
  readonly installationId: string;
  readonly organization?: OrgInferenceSettings | null;
  /** Ids killed in every mode. */
  readonly killedModels?: ReadonlySet<string>;
  /** Ids killed in one mode only: a provider kill, or an executor-native id only that mode's route runs. */
  readonly killedModelsByMode?: Readonly<Partial<Record<InferenceMode, ReadonlySet<string>>>>;
  readonly revision: string;
}): ResolvedInferencePlan {
  const { catalog, organization } = input;
  const nodeModes = input.modes ?? [input.mode];
  const orgModes = organization?.modes ?? null;
  const usable = INFERENCE_MODES.filter((id) =>
    nodeModes.includes(id) && (orgModes === null || orgModes.includes(id)) && catalog.modes[id] !== undefined);
  const managed = organization?.mode && usable.includes(organization.mode.value) ? organization.mode : undefined;
  // Only the organization moves the default off the Node's: a catalog without
  // the Node's mode leaves it in place with nothing to run, so Confidential
  // never silently becomes Zero Data Retention.
  const orgExcludesNodeDefault = orgModes !== null && !orgModes.includes(input.mode);
  const defaultMode = managed?.value ?? (orgExcludesNodeDefault ? usable[0] ?? input.mode : input.mode);
  const visibility = managed?.mode ?? "default";
  const choices = usable.length === 0 ? [] : visibility === "default" ? usable : [defaultMode];

  const byMode: Partial<Record<InferenceMode, InferencePlanMode>> = {};
  const acceptedByMode: Partial<Record<InferenceMode, ReadonlySet<string>>> = {};
  for (const mode of choices) {
    const resolved = resolveMode({ ...input, killedModels: union(input.killedModels, input.killedModelsByMode?.[mode]) }, mode);
    byMode[mode] = { models: resolved.models, jobs: resolved.jobs };
    acceptedByMode[mode] = resolved.accepted;
  }
  const current = byMode[defaultMode] ?? { models: [], jobs: {} };
  const plan: InferencePlan = {
    schemaVersion: 1,
    revision: input.revision,
    mode: defaultMode,
    // A mode with a notice is listed even when the catalog does not offer it: the notice says why.
    // A hidden mode is never listed (unless it is the one in use, which validation prevents).
    modes: INFERENCE_MODES.filter((id) => (catalog.modes[id] !== undefined || organization?.modeNotices?.[id] !== undefined)
      && !(organization?.hiddenModes?.includes(id) && !choices.includes(id))).map((id) => {
      const notice = choices.includes(id) ? undefined : organization?.modeNotices?.[id];
      return {
        id,
        label: INFERENCE_MODE_LABELS[id],
        allowed: choices.includes(id),
        current: id === defaultMode,
        ...(notice ? { notice } : {}),
      };
    }),
    ...(choices.length > 0 ? { modeChoice: { default: defaultMode, choices, visibility } } : {}),
    models: current.models,
    jobs: current.jobs,
    ...(choices.length > 0 ? { byMode } : {}),
    ...(organization?.agentOnlyJobs?.length ? { agentOnlyJobs: [...organization.agentOnlyJobs] } : {}),
  };
  return { plan, accepted: acceptedByMode[defaultMode] ?? new Set<string>(), acceptedByMode };
}

function union(a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined): ReadonlySet<string> | undefined {
  return a && b ? new Set([...a, ...b]) : a ?? b;
}

/** One mode's offers, narrowed by organization settings and kills. */
function resolveMode(input: {
  readonly catalog: InferenceCatalog;
  readonly installationId: string;
  readonly organization?: OrgInferenceSettings | null;
  readonly killedModels?: ReadonlySet<string>;
}, mode: InferenceMode): InferencePlanMode & { readonly accepted: ReadonlySet<string> } {
  const { catalog, organization } = input;
  const killed = input.killedModels ?? new Set<string>();
  const entry = catalog.modes[mode];
  const modelsById = new Map(catalog.models.map((model) => [model.id, model]));
  // Policies may name a model by an alias; a kill on any of its ids kills it.
  const orgModels = organization?.models?.[mode]?.map((id) => inferenceCatalogModel(catalog, id)?.id ?? id) ?? null;
  const isKilled = (model: InferenceCatalogModel) => killed.has(model.id) || model.aliases.some((alias) => killed.has(alias));
  const offered: InferenceCatalogModel[] = [];
  for (const offer of entry?.offers ?? []) {
    const model = modelsById.get(offer.model)!;
    if (isKilled(model)) continue;
    if (orgModels !== null && !orgModels.includes(model.id)) continue;
    offered.push(model);
  }
  const accepted = new Set(offered.flatMap((model) => [model.id, ...model.aliases]));
  const labelFor = (model: InferenceCatalogModel) =>
    inferenceRouteFor(catalog, { mode, modelId: model.id, installationId: input.installationId })?.label ?? model.label;

  const jobs: Partial<Record<InferenceJob, InferencePlanJob>> = {};
  const agentOnly = new Set(organization?.agentOnlyJobs ?? []);
  for (const definition of INFERENCE_JOB_DEFINITIONS) {
    if (agentOnly.has(definition.job)) continue;
    const candidates = offered.filter((model) => servesJob(model, definition)).map((model) => model.id);
    const usable = (id: string | undefined): id is string => {
      const model = id === undefined ? undefined : modelsById.get(id);
      return id !== undefined && accepted.has(id) && model !== undefined && servesJob(model, definition);
    };
    const policyJob = organization?.jobs?.[mode]?.[definition.job];
    const managed = policyJob ? { ...policyJob, value: inferenceCatalogModel(catalog, policyJob.value)?.id ?? policyJob.value } : undefined;
    const fallbackPool = (entry?.fallbacks[definition.job] ?? []).filter((id) => usable(id));
    const fallbackDefault = usable(entry?.defaults[definition.job]) ? entry!.defaults[definition.job]! : fallbackPool[0] ?? candidates[0];
    const preferred = usable(managed?.value) ? managed!.value : fallbackDefault;
    if (!preferred) continue;
    const visibility = managed && usable(managed.value) ? managed.mode : "default";
    jobs[definition.job] = {
      default: preferred,
      choices: visibility === "default" ? [...new Set([preferred, ...candidates])] : [preferred],
      fallbacks: fallbackPool.filter((id) => id !== preferred),
      visibility,
    };
  }

  return {
    models: offered.map((model) => ({
      id: model.id,
      label: labelFor(model),
      ...(model.description ? { description: model.description } : {}),
      kind: model.kind,
      capabilities: model.capabilities,
    })),
    jobs,
    accepted,
  };
}

// ---------------------------------------------------------------------------
// Released-client projection (`GET /inference/models`, schemaVersion 1)
// ---------------------------------------------------------------------------

/** Shape released desktops parse; Cloud validates it against its own schema. */
export interface LegacyInferenceModelAssignment {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly roles: Readonly<Record<"chunkAnalysis" | "intentLoop" | "screenVlm" | "stt" | "redaction",
    { readonly modelId: string; readonly fallbackModelIds: readonly string[] }>>;
  readonly catalog: { readonly chat: readonly { id: string; label: string }[]; readonly stt: readonly { id: string; label: string }[] };
  readonly sunsetRemaps: Readonly<Record<string, string>>;
  readonly unavailableModelIds: readonly string[];
}

const LEGACY_ROLE_JOBS = {
  chunkAnalysis: "memory",
  intentLoop: "intent",
  screenVlm: "screen",
  stt: "transcription",
  redaction: "redaction",
} as const satisfies Record<keyof LegacyInferenceModelAssignment["roles"], InferenceJob>;

/**
 * The assignment released desktops (harness v1, chunk analysis) understand,
 * built from the same plan. They keep the ids they know: each model's first
 * alias, with its other aliases remapped to it. Returns null when the plan
 * lacks a job those clients require; Cloud then serves its previous assignment.
 */
export function legacyAssignmentFromPlan(
  resolved: ResolvedInferencePlan,
  catalog: InferenceCatalog,
): LegacyInferenceModelAssignment | null {
  const { plan, accepted } = resolved;
  const legacyId = (id: string) => inferenceCatalogModel(catalog, id)?.aliases[0] ?? id;
  const roles = {} as Record<keyof LegacyInferenceModelAssignment["roles"], { modelId: string; fallbackModelIds: string[] }>;
  for (const [role, job] of Object.entries(LEGACY_ROLE_JOBS) as [keyof typeof LEGACY_ROLE_JOBS, InferenceJob][]) {
    const entry = plan.jobs[job];
    if (!entry) return null;
    roles[role] = { modelId: legacyId(entry.default), fallbackModelIds: entry.fallbacks.map(legacyId).slice(0, 8) };
  }
  const listing = (kind: InferenceModelKind) => plan.models
    .filter((model) => model.kind === kind)
    .map((model) => ({ id: legacyId(model.id), label: model.label }));
  const chat = listing("chat");
  const stt = listing("transcription");
  if (chat.length === 0 || stt.length === 0) return null;
  const sunsetRemaps: Record<string, string> = {};
  for (const model of catalog.models) {
    if (!accepted.has(model.id)) continue;
    for (const alias of model.aliases.slice(1)) sunsetRemaps[alias] = model.aliases[0]!;
  }
  const unavailable = catalog.models
    .filter((model) => !accepted.has(model.id) && model.kind !== "embedding")
    .flatMap((model) => [model.id, ...model.aliases]);
  return {
    schemaVersion: 1,
    version: plan.revision.slice(0, 80).replace(/[^A-Za-z0-9._:-]/g, "-"),
    roles,
    catalog: { chat: chat.slice(0, 32), stt: stt.slice(0, 16) },
    sunsetRemaps,
    unavailableModelIds: unavailable.slice(0, 64),
  };
}
