import { describe, expect, it } from "vitest";
import {
  inferenceCatalogSchema,
  inferencePlanSchema,
  inferencePriceVersionSchema,
  inferenceRouteFor,
  legacyAssignmentFromPlan,
  resolveInferencePlan,
  type InferenceCatalog,
} from "./inference-catalog.js";
import { desktopCompatibleOrgPolicy, orgInferenceSettings, orgPolicySchema } from "./org-policy.js";
import { inferenceModelAssignmentSchema } from "./inference-model-assignment.js";

// Production shape on 2026-10-03, with proper ids: Zero Data Retention runs
// Gemma and GLM-5 on Bedrock; released clients still send the older ids.
const catalog: InferenceCatalog = inferenceCatalogSchema.parse({
  schemaVersion: 1,
  models: [
    { id: "gemma-4-31b", label: "Gemma 4 31B", kind: "chat", capabilities: { vision: true, tools: true },
      aliases: ["gemma4-31b", "glm-5-3-flash", "deepseek-v4-1-flash", "deepseek-v4-flash", "google.gemma-4-31b"] },
    { id: "glm-5", label: "GLM-5", kind: "chat", capabilities: { tools: true, reasoning: true }, aliases: ["glm-5-3", "zai.glm-5"] },
    { id: "whisper-large-v3", label: "Whisper Large v3", kind: "transcription" },
    { id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo", kind: "transcription" },
    { id: "baai/bge-m3", label: "BGE-M3", kind: "embedding" },
  ],
  modes: {
    "zero-retention": {
      offers: [
        { model: "gemma-4-31b", route: { provider: "bedrock", region: "eu-central-1" } },
        { model: "glm-5", route: { provider: "bedrock", region: "eu-north-1" } },
        { model: "whisper-large-v3", route: { provider: "openrouter" } },
        { model: "whisper-large-v3-turbo", route: { provider: "openrouter" } },
        { model: "baai/bge-m3", route: { provider: "openrouter" } },
      ],
      defaults: {
        screen: "gemma-4-31b", memory: "gemma-4-31b", intent: "gemma-4-31b", redaction: "gemma-4-31b",
        transcription: "whisper-large-v3", retrieval: "baai/bge-m3", live_reasoning: "gemma-4-31b",
        deep_reasoning: "glm-5", consolidation: "gemma-4-31b", look: "gemma-4-31b", daily_report: "gemma-4-31b",
      },
      fallbacks: { deep_reasoning: ["gemma-4-31b"] },
    },
  },
  routeOverrides: [{
    installationId: "inst_alexandria_valenlabs",
    mode: "zero-retention",
    models: ["gemma-4-31b", "glm-5"],
    route: { provider: "openrouter" },
    labels: { "glm-5": "GLM-5.3" },
  }],
});

describe("inference catalog", () => {
  it("refuses defaults a mode cannot serve and providers a mode cannot use", () => {
    const broken = structuredClone(catalog) as Record<string, any>;
    broken.modes["zero-retention"].defaults.screen = "glm-5";
    broken.modes["zero-retention"].offers[0].route = { provider: "tinfoil" };
    broken.models[1].aliases.push("gemma4-31b");
    const issues = inferenceCatalogSchema.safeParse(broken).error?.issues.map((issue) => issue.message) ?? [];
    expect(issues).toContain("glm-5 cannot serve screen in zero-retention.");
    expect(issues).toContain("tinfoil cannot serve zero-retention.");
    expect(issues).toContain("gemma4-31b already names another model.");
  });

  it("routes proper ids and released-client aliases per Node", () => {
    expect(inferenceRouteFor(catalog, { mode: "zero-retention", modelId: "glm-5", installationId: "inst_public_prod" }))
      .toEqual({ route: { provider: "bedrock", region: "eu-north-1" }, label: null, modelId: "glm-5" });
    expect(inferenceRouteFor(catalog, { mode: "zero-retention", modelId: "glm-5-3", installationId: "inst_alexandria_valenlabs" }))
      .toEqual({ route: { provider: "openrouter" }, label: "GLM-5.3", modelId: "glm-5" });
    expect(inferenceRouteFor(catalog, { mode: "zero-retention", modelId: "deepseek-v4-1-flash", installationId: "inst_public_prod" }))
      .toEqual({ route: { provider: "bedrock", region: "eu-central-1" }, label: null, modelId: "gemma-4-31b" });
    expect(inferenceRouteFor(catalog, { mode: "confidential", modelId: "glm-5", installationId: "inst_public_prod" })).toBeNull();
  });

  it("offers current clients proper ids only, accepts released-client ids, and keeps vision jobs on vision models", () => {
    const { plan, accepted } = resolveInferencePlan({ catalog, mode: "zero-retention", installationId: "inst_public_prod", revision: "c1.p0" });
    expect(inferencePlanSchema.parse(plan)).toEqual(plan);
    expect(plan.models.map((model) => model.id)).toEqual(["gemma-4-31b", "glm-5", "whisper-large-v3", "whisper-large-v3-turbo", "baai/bge-m3"]);
    expect(accepted.has("glm-5-3-flash")).toBe(true);
    expect(accepted.has("zai.glm-5")).toBe(true);
    expect(plan.jobs.screen).toEqual({ default: "gemma-4-31b", choices: ["gemma-4-31b"], fallbacks: [], visibility: "default" });
    expect(plan.jobs.deep_reasoning).toEqual({ default: "glm-5", choices: ["glm-5", "gemma-4-31b"], fallbacks: ["gemma-4-31b"], visibility: "default" });
    expect(plan.jobs.transcription?.choices).toEqual(["whisper-large-v3", "whisper-large-v3-turbo"]);
  });

  it("plan settings (ADR-0324): agent-only jobs have no Alexandria model; an unavailable mode carries its notice", () => {
    const { plan } = resolveInferencePlan({
      catalog, mode: "zero-retention", modes: ["confidential", "zero-retention"], installationId: "inst_public_prod", revision: "c1.p1",
      organization: {
        modes: ["zero-retention"],
        agentOnlyJobs: ["live_reasoning", "deep_reasoning"],
        modeNotices: { confidential: "Confidential inference is at capacity.", "zero-retention": "Never shown: this mode is allowed." },
      },
    });
    expect(inferencePlanSchema.parse(plan)).toEqual(plan);
    expect(plan.agentOnlyJobs).toEqual(["live_reasoning", "deep_reasoning"]);
    expect(plan.jobs.deep_reasoning).toBeUndefined();
    expect(plan.jobs.live_reasoning).toBeUndefined();
    expect(plan.jobs.screen).toBeDefined();
    expect(plan.modes.find((mode) => mode.id === "confidential")).toMatchObject({ allowed: false, notice: "Confidential inference is at capacity." });
    expect(plan.modes.find((mode) => mode.id === "zero-retention")?.notice).toBeUndefined();
  });

  it("a hidden mode is left out of the plan's modes", () => {
    const { plan } = resolveInferencePlan({
      catalog, mode: "zero-retention", modes: ["confidential", "zero-retention"], installationId: "inst_public_prod", revision: "c1.p2",
      organization: { modes: ["zero-retention"], hiddenModes: ["confidential"], modeNotices: { confidential: "Never shown: the mode is hidden." } },
    });
    expect(plan.modes.map((mode) => mode.id)).toEqual(["zero-retention"]);
  });

  it("applies organization narrowing (also by released-client ids), locked and hidden jobs, and kills", () => {
    const { plan, accepted } = resolveInferencePlan({
      catalog, mode: "zero-retention", installationId: "inst_alexandria_internal", revision: "c1.p3",
      killedModels: new Set(["whisper-large-v3-turbo"]),
      organization: {
        // A pre-ADR-0297 policy names models by the ids released desktops use.
        models: { "zero-retention": ["gemma4-31b", "whisper-large-v3", "whisper-large-v3-turbo", "baai/bge-m3"] },
        jobs: { "zero-retention": { deep_reasoning: { mode: "hidden", value: "gemma4-31b" }, transcription: { mode: "locked", value: "whisper-large-v3" } } },
      },
    });
    expect(accepted.has("glm-5")).toBe(false);
    expect(accepted.has("glm-5-3")).toBe(false);
    expect(accepted.has("deepseek-v4-1-flash")).toBe(true);
    expect(accepted.has("whisper-large-v3-turbo")).toBe(false);
    expect(plan.jobs.deep_reasoning).toEqual({ default: "gemma-4-31b", choices: ["gemma-4-31b"], fallbacks: [], visibility: "hidden" });
    expect(plan.jobs.transcription).toEqual({ default: "whisper-large-v3", choices: ["whisper-large-v3"], fallbacks: [], visibility: "locked" });
  });

  it("lets desktops read plans from a newer Cloud", () => {
    const { plan } = resolveInferencePlan({ catalog, mode: "zero-retention", installationId: "inst_public_prod", revision: "c1.p0" });
    const newer = { ...plan, organizationName: "Valen Labs", jobs: { ...plan.jobs, translation: plan.jobs.memory } };
    expect(inferencePlanSchema.parse(newer)).toEqual(plan);
  });

  it("refuses everything in a mode the organization cannot use", () => {
    const { plan, accepted } = resolveInferencePlan({
      catalog, mode: "zero-retention", installationId: "inst_public_prod", revision: "c1.p4",
      organization: { modes: ["confidential"] },
    });
    expect(accepted.size).toBe(0);
    expect(plan.jobs).toEqual({});
    expect(plan.modes).toEqual([{ id: "zero-retention", label: "Alexandria Zero Data Retention", allowed: false, current: true }]);
  });

  it("projects the same plan for released desktops with the ids they know", () => {
    const resolved = resolveInferencePlan({ catalog, mode: "zero-retention", installationId: "inst_public_prod", revision: "c1.p0" });
    const assignment = legacyAssignmentFromPlan(resolved, catalog);
    expect(inferenceModelAssignmentSchema.parse(assignment)).toEqual(assignment);
    expect(assignment).toEqual({
      schemaVersion: 1,
      version: "c1.p0",
      roles: {
        chunkAnalysis: { modelId: "gemma4-31b", fallbackModelIds: [] },
        intentLoop: { modelId: "gemma4-31b", fallbackModelIds: [] },
        screenVlm: { modelId: "gemma4-31b", fallbackModelIds: [] },
        stt: { modelId: "whisper-large-v3", fallbackModelIds: [] },
        redaction: { modelId: "gemma4-31b", fallbackModelIds: [] },
      },
      catalog: {
        chat: [{ id: "gemma4-31b", label: "Gemma 4 31B" }, { id: "glm-5-3", label: "GLM-5" }],
        stt: [{ id: "whisper-large-v3", label: "Whisper Large v3" }, { id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo" }],
      },
      sunsetRemaps: {
        "glm-5-3-flash": "gemma4-31b", "deepseek-v4-1-flash": "gemma4-31b", "deepseek-v4-flash": "gemma4-31b",
        "google.gemma-4-31b": "gemma4-31b", "zai.glm-5": "glm-5-3",
      },
      unavailableModelIds: [],
    });
  });

  it("keeps price versions free of duplicate rows, per executor", () => {
    const row = { route: "/v1/chat/completions", modelId: "google.gemma-4-31b", inputMicrosPerMillion: "201600", outputMicrosPerMillion: "576000", reservationMicros: "60000" };
    expect(inferencePriceVersionSchema.safeParse({ version: "v1", prices: [row] }).success).toBe(true);
    expect(inferencePriceVersionSchema.safeParse({ version: "v1", prices: [row, row] }).success).toBe(false);
    // The same client id on Tinfoil and OpenRouter can cost differently.
    const tinfoil = { ...row, modelId: "gemma-4-31b", provider: "tinfoil" };
    const openrouter = { ...tinfoil, provider: "openrouter" };
    expect(inferencePriceVersionSchema.safeParse({ version: "v1", prices: [tinfoil, openrouter, { ...row, modelId: "gemma-4-31b" }] }).success).toBe(true);
    expect(inferencePriceVersionSchema.safeParse({ version: "v1", prices: [tinfoil, tinfoil] }).success).toBe(false);
  });
});

// ADR-0313: one Node serves every mode its operator allows; each account uses one.
const twoModes: InferenceCatalog = inferenceCatalogSchema.parse({
  ...catalog,
  modes: {
    ...catalog.modes,
    confidential: {
      offers: [
        { model: "gemma-4-31b", route: { provider: "tinfoil" } },
        { model: "whisper-large-v3", route: { provider: "tinfoil" } },
      ],
      defaults: {
        screen: "gemma-4-31b", memory: "gemma-4-31b", intent: "gemma-4-31b", redaction: "gemma-4-31b", transcription: "whisper-large-v3",
        live_reasoning: "gemma-4-31b", deep_reasoning: "gemma-4-31b", consolidation: "gemma-4-31b", look: "gemma-4-31b", daily_report: "gemma-4-31b",
      },
    },
  },
});

describe("inference modes per account", () => {
  it("offers every mode the Node serves, defaulting to the Node's mode", () => {
    const { plan, accepted, acceptedByMode } = resolveInferencePlan({
      catalog: twoModes, mode: "zero-retention", modes: ["confidential", "zero-retention"], installationId: "inst_public_prod", revision: "c2.p0",
    });
    expect(inferencePlanSchema.parse(plan)).toEqual(plan);
    expect(plan.mode).toBe("zero-retention");
    expect(plan.modeChoice).toEqual({ default: "zero-retention", choices: ["confidential", "zero-retention"], visibility: "default" });
    expect(plan.modes.map((mode) => [mode.id, mode.allowed, mode.current])).toEqual([["confidential", true, false], ["zero-retention", true, true]]);
    expect(plan.jobs.deep_reasoning?.default).toBe("glm-5");
    expect(plan.byMode?.confidential?.jobs.deep_reasoning?.default).toBe("gemma-4-31b");
    expect(plan.byMode?.confidential?.models.map((model) => model.id)).toEqual(["gemma-4-31b", "whisper-large-v3"]);
    expect(accepted.has("glm-5")).toBe(true);
    expect(acceptedByMode.confidential?.has("glm-5")).toBe(false);
    expect(acceptedByMode.confidential?.has("gemma4-31b")).toBe(true);
  });

  it("lets the organization set, lock or hide the mode, per-mode jobs included", () => {
    const { plan, acceptedByMode } = resolveInferencePlan({
      catalog: twoModes, mode: "zero-retention", modes: ["confidential", "zero-retention"], installationId: "inst_public_prod", revision: "c2.p1",
      organization: {
        mode: { mode: "locked", value: "confidential" },
        jobs: { confidential: { transcription: { mode: "hidden", value: "whisper-large-v3" } } },
      },
    });
    expect(plan.mode).toBe("confidential");
    expect(plan.modeChoice).toEqual({ default: "confidential", choices: ["confidential"], visibility: "locked" });
    expect(plan.jobs.transcription?.visibility).toBe("hidden");
    expect(Object.keys(plan.byMode ?? {})).toEqual(["confidential"]);
    // A locked choice refuses the other mode outright.
    expect(acceptedByMode["zero-retention"]).toBeUndefined();
  });

  it("never offers a mode the Node or the organization does not allow", () => {
    const nodeOnly = resolveInferencePlan({ catalog: twoModes, mode: "zero-retention", installationId: "inst_public_prod", revision: "c2.p2" });
    expect(nodeOnly.plan.modeChoice).toEqual({ default: "zero-retention", choices: ["zero-retention"], visibility: "default" });
    expect(nodeOnly.acceptedByMode.confidential).toBeUndefined();
    const orgNarrowed = resolveInferencePlan({
      catalog: twoModes, mode: "zero-retention", modes: ["confidential", "zero-retention"], installationId: "inst_public_prod", revision: "c2.p3",
      organization: { modes: ["confidential"], mode: { mode: "default", value: "zero-retention" } },
    });
    // The organization's default is not allowed, so the first usable mode is.
    expect(orgNarrowed.plan.mode).toBe("confidential");
    expect(orgNarrowed.plan.modeChoice).toEqual({ default: "confidential", choices: ["confidential"], visibility: "default" });
    expect(orgNarrowed.accepted.has("glm-5")).toBe(false);
  });

  it("keeps the Node's default mode when only the catalog lacks it, and kills per mode", () => {
    const zeroRetentionOnly = inferenceCatalogSchema.parse({ ...twoModes, modes: { "zero-retention": twoModes.modes["zero-retention"] } });
    const missing = resolveInferencePlan({
      catalog: zeroRetentionOnly, mode: "confidential", modes: ["confidential", "zero-retention"], installationId: "inst_public_prod", revision: "c2.p4",
    });
    expect(missing.plan.mode).toBe("confidential");
    expect(missing.plan.jobs).toEqual({});
    expect(missing.accepted.size).toBe(0);
    // The person may still pick Zero Data Retention themselves.
    expect(missing.plan.modeChoice?.choices).toEqual(["zero-retention"]);
    const killed = resolveInferencePlan({
      catalog: twoModes, mode: "zero-retention", modes: ["confidential", "zero-retention"], installationId: "inst_public_prod", revision: "c2.p5",
      killedModelsByMode: { "zero-retention": new Set(["gemma-4-31b"]) },
    });
    expect(killed.acceptedByMode["zero-retention"]?.has("gemma-4-31b")).toBe(false);
    expect(killed.acceptedByMode.confidential?.has("gemma-4-31b")).toBe(true);
  });

  it("projects released desktops from the default mode only", () => {
    const resolved = resolveInferencePlan({
      catalog: twoModes, mode: "zero-retention", modes: ["confidential", "zero-retention"], installationId: "inst_public_prod", revision: "c2.p0",
    });
    expect(legacyAssignmentFromPlan(resolved, twoModes)?.catalog.chat).toEqual([{ id: "gemma4-31b", label: "Gemma 4 31B" }, { id: "glm-5-3", label: "GLM-5" }]);
  });
});

describe("organization inference settings", () => {
  it("refuses a default mode or job settings the organization cannot use", () => {
    const result = orgPolicySchema.safeParse({
      schemaVersion: 1,
      inference: {
        modes: ["zero-retention"],
        mode: { mode: "default", value: "confidential" },
        models: { "zero-retention": ["gemma-4-31b"] },
        jobs: { confidential: { memory: { mode: "default", value: "gemma-4-31b" } }, "zero-retention": { memory: { mode: "locked", value: "glm-5" } } },
      },
    });
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "The default mode must be allowed.", "Jobs are set for a mode the organization cannot use.", "Model must be allowed in this mode.",
    ]));
  });

  it("reads flat pre-ADR-0297 fields as the same narrowing for every mode", () => {
    const policy = orgPolicySchema.parse({
      schemaVersion: 1,
      inference: { allowedProviders: ["zero-retention", "claude"], allowedModels: ["gemma4-31b", "whisper-large-v3"], transcriptionModel: { mode: "locked", value: "whisper-large-v3" } },
    });
    expect(orgInferenceSettings(policy.inference)).toEqual({
      modes: ["zero-retention"],
      models: { confidential: ["gemma4-31b", "whisper-large-v3"], "zero-retention": ["gemma4-31b", "whisper-large-v3"] },
      jobs: {
        confidential: { transcription: { mode: "locked", value: "whisper-large-v3" } },
        "zero-retention": { transcription: { mode: "locked", value: "whisper-large-v3" } },
      },
    });
  });

  it("gives released desktops only the fields their strict parser knows", () => {
    const policy = orgPolicySchema.parse({
      schemaVersion: 1,
      inference: {
        modes: ["zero-retention"],
        models: { "zero-retention": ["gemma-4-31b", "baai/bge-m3"] },
        mode: { mode: "locked", value: "zero-retention" },
        jobs: { "zero-retention": { retrieval: { mode: "hidden", value: "baai/bge-m3" }, memory: { mode: "locked", value: "gemma-4-31b" } } },
      },
    });
    const desktop = desktopCompatibleOrgPolicy(policy, catalog);
    expect(desktop.inference).not.toHaveProperty("modes");
    expect(desktop.inference).not.toHaveProperty("mode");
    expect(desktop.inference).not.toHaveProperty("models");
    expect(desktop.inference).not.toHaveProperty("jobs");
    expect(desktop.inference.retrievalModel).toEqual({ mode: "hidden", value: "baai/bge-m3" });
    // Only Zero Data Retention is usable, so its list is what released desktops see.
    expect(desktop.inference.allowedModels).toEqual(["gemma-4-31b", "gemma4-31b", "glm-5-3-flash", "deepseek-v4-1-flash", "deepseek-v4-flash", "google.gemma-4-31b", "baai/bge-m3"]);
    expect(desktop.inference.allowedProviders).toEqual(["zero-retention", "chatgpt", "claude"]);
    expect(orgPolicySchema.safeParse(desktop).success).toBe(true);
    const narrowed = desktopCompatibleOrgPolicy(orgPolicySchema.parse({
      schemaVersion: 1,
      inference: { models: { confidential: [], "zero-retention": ["gemma-4-31b"] } },
    }), catalog);
    expect(narrowed.inference.allowedModels).toEqual(["gemma-4-31b", "gemma4-31b", "glm-5-3-flash", "deepseek-v4-1-flash", "deepseek-v4-flash", "google.gemma-4-31b"]);
  });
});
