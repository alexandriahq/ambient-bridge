import { describe, expect, it } from "vitest";
import {
  emptyOrgPolicy,
  ORG_FEATURES,
  ORG_FEATURE_KEYS,
  orgFeatureEnabled,
  orgPolicyFeatureSlugs,
  COMPANY_PROFILES,
  compileMultiplayerToCompanyProfile,
  multiplayerPresetDefaults,
  orgPolicyLegacyFeatureSlugs,
  orgPolicySchema,
  desktopCompatibleOrgPolicy,
  staticPolicyCatalog,
} from "./index.js";

describe("org policy", () => {
  it("parses an empty document to product defaults", () => {
    const policy = emptyOrgPolicy();
    expect(policy.features).toEqual({});
    expect(policy.inference.allowedProviders).toBeNull();
    expect(policy.onboarding.steps).toBeNull();
    expect(policy.multiplayer).toBeNull();
    expect(policy.capture.allowUnknownFocus).toEqual({ keyboard: false, pointer: false });
    expect(orgPolicyLegacyFeatureSlugs(policy)).toEqual([]);
  });

  it("registers every feature key exactly once with a unique legacy slug", () => {
    expect(ORG_FEATURES.map((feature) => feature.key).sort()).toEqual([...ORG_FEATURE_KEYS].sort());
    expect(new Set(ORG_FEATURES.map((feature) => feature.legacySlug)).size).toBe(ORG_FEATURES.length);
  });

  it("requires a parent feature and emits legacy slugs only for effective features", () => {
    const rejected = orgPolicySchema.safeParse({ schemaVersion: 1, features: { automationToggleTrack: true } });
    expect(rejected.success).toBe(false);
    const policy = orgPolicySchema.parse({ schemaVersion: 1, features: { automations: true, automationToggleTrack: true, agents: false } });
    expect(orgFeatureEnabled(policy, "automationToggleTrack")).toBe(true);
    expect(orgPolicyLegacyFeatureSlugs(policy)).toEqual(["automations-enabled", "automations-toggle-track-available"]);
  });

  it("keeps managed values inside their allowlists", () => {
    const result = orgPolicySchema.safeParse({
      schemaVersion: 1,
      inference: { allowedProviders: ["confidential"], provider: { mode: "locked", value: "claude" }, fallbackProviders: ["chatgpt"] },
      capture: { allowedSources: ["screen"], enabledSources: { mode: "default", value: ["screen", "microphone"] } },
      agents: { allowedAgents: ["codex"], autoConnectAgents: ["claude"], defaultAgent: { mode: "locked", value: "claude" } },
    });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((issue) => issue.path.join("."));
    expect(paths).toEqual(expect.arrayContaining([
      "inference.provider",
      "inference.fallbackProviders.0",
      "capture.enabledSources.value.1",
      "agents.autoConnectAgents.0",
      "agents.defaultAgent",
    ]));
  });

  it("rejects unknown keys and duplicate onboarding steps", () => {
    expect(orgPolicySchema.safeParse({ schemaVersion: 1, surprise: true }).success).toBe(false);
    expect(orgPolicySchema.safeParse({ schemaVersion: 1, onboarding: { steps: [{ id: "privacy" }, { id: "privacy" }] } }).success).toBe(false);
  });

  it("models the Valen Labs setup without code", () => {
    const valen = orgPolicySchema.parse({
      schemaVersion: 1,
      features: { agents: false, actionsCapture: true, actionsInSidebar: true },
      capture: {
        redactionLevel: { mode: "default", value: "off" },
        allowUnknownFocus: { keyboard: true, pointer: true },
        appRules: [{ target: "app", pattern: "com.1password.1password", list: "excluded", mode: "locked" }],
      },
      multiplayer: { ...multiplayerPresetDefaults("data_collection"), sharing: { mode: "locked", value: "auto" }, includeHistory: true },
    });
    expect(orgFeatureEnabled(valen, "agents")).toBe(false);
    const compiled = compileMultiplayerToCompanyProfile(valen.multiplayer!, valen.capture.appRules);
    expect(compiled.profile).toBe("data_collection");
    expect(compiled.settings).toMatchObject({ collectionEnabled: true, uploadExistingLocalData: true, reportsEnabled: false,
      blockList: [{ target: "app", pattern: "com.1password.1password" }] });
  });

  it("lets a policy decide registry and capture-privacy slugs while unknown WorkOS slugs pass through", () => {
    const workos = ["enable-agents", "text-redaction-default-off", "devtools-visible", "enable-skills", "keyboard-capture-allow-unknown"];
    expect(orgPolicyFeatureSlugs(workos, null)).toEqual([...workos].sort());
    const policy = orgPolicySchema.parse({
      schemaVersion: 1,
      features: { actionsCapture: true, agents: false },
      capture: { allowUnknownFocus: { keyboard: false, pointer: true } },
    });
    expect(orgPolicyFeatureSlugs(workos, policy)).toEqual(["enable-actions-capture", "enable-skills", "pointer-capture-allow-unknown"]);
    const off = orgPolicySchema.parse({ schemaVersion: 1, capture: { redactionLevel: { mode: "locked", value: "off" } } });
    expect(orgPolicyFeatureSlugs([], off)).toEqual(["text-redaction-default-off"]);
  });

  it("rejects forcing a never-leaves-device data type to share and duplicate app rules", () => {
    const forced = orgPolicySchema.safeParse({ schemaVersion: 1, multiplayer: { dataTypes: { keystrokes: { allowed: false, share: { mode: "locked", value: true } } } } });
    expect(forced.success).toBe(false);
    const duplicate = orgPolicySchema.safeParse({ schemaVersion: 1, capture: { appRules: [
      { target: "website", pattern: "a.example", list: "excluded", mode: "locked" },
      { target: "website", pattern: "A.example", list: "recorded", mode: "default" },
    ] } });
    expect(duplicate.success).toBe(false);
  });

  it.each(COMPANY_PROFILES)("preset %s compiles back to its own profile", (profile) => {
    const section = multiplayerPresetDefaults(profile);
    expect(orgPolicySchema.safeParse({ schemaVersion: 1, multiplayer: section }).success).toBe(true);
    expect(compileMultiplayerToCompanyProfile(section).profile).toBe(profile);
    expect(compileMultiplayerToCompanyProfile({ ...section, preset: null }).profile).toBe(profile);
  });

  it("publishes a JSON schema in the catalog", () => {
    const catalog = staticPolicyCatalog();
    expect(catalog.features.length).toBe(ORG_FEATURES.length);
    expect(catalog.policyJsonSchema).toMatchObject({ type: "object" });
  });
});

describe("mode states (ADR-0324)", () => {
  it("a hidden mode must be outside the available modes", () => {
    expect(orgPolicySchema.safeParse({ schemaVersion: 1, inference: { modes: ["zero-retention"], hiddenModes: ["confidential"] } }).success).toBe(true);
    expect(orgPolicySchema.safeParse({ schemaVersion: 1, inference: { modes: ["zero-retention"], hiddenModes: ["zero-retention"] } }).success).toBe(false);
    // Every mode available (modes absent) leaves nothing to hide.
    expect(orgPolicySchema.safeParse({ schemaVersion: 1, inference: { hiddenModes: ["confidential"] } }).success).toBe(false);
  });

  it("released desktops never receive mode states", () => {
    const policy = orgPolicySchema.parse({ schemaVersion: 1, inference: { modes: ["zero-retention"], hiddenModes: ["confidential"], modeNotices: { confidential: "At capacity." } } });
    const served = desktopCompatibleOrgPolicy(policy) as { inference: Record<string, unknown> };
    expect(served.inference.hiddenModes).toBeUndefined();
    expect(served.inference.modeNotices).toBeUndefined();
  });
});
