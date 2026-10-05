import { describe, expect, it } from "vitest";
import {
  GLOBAL_CONTROL_FEATURES,
  desktopOrgPolicyResponseSchema,
  effectiveOrgPolicy,
  globalControlApplies,
  globalControlSchema,
  globalControlsSchema,
  globalKillsFor,
  globallyDisabledMessage,
  orgFeatureEnabled,
  orgPolicySchema,
  parseGlobalControlTarget,
  parseGloballyDisabledMessage,
  staticPolicyCatalog,
  withoutGloballyDisabledSlugs,
  type GlobalControl,
  type GlobalControlTarget,
} from "./index.js";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const actor = { kind: "operator", id: "user_op", email: "op@alexandria.so", client: null } as const;

function control(target: GlobalControlTarget, overrides: Partial<GlobalControl> = {}): GlobalControl {
  return globalControlSchema.parse({
    target,
    enabled: false,
    scope: { mode: "all" },
    notice: null,
    reason: "Vendor incident",
    actor,
    createdAt: "2026-10-02T11:00:00.000Z",
    expiresAt: null,
    ...overrides,
  });
}

const policy = orgPolicySchema.parse({
  schemaVersion: 1,
  features: { agents: true, reports: true, actionsCapture: true, automations: true },
  inference: {
    allowedProviders: ["confidential", "zero-retention", "chatgpt"],
    provider: { mode: "locked", value: "zero-retention" },
    fallbackProviders: ["zero-retention", "confidential"],
    allowedModels: ["model-a", "vendor/model-b"],
    transcriptionModel: { mode: "default", value: "vendor/model-b" },
  },
  capture: { allowedSources: ["screen", "pointer_actions"], enabledSources: { mode: "default", value: ["screen", "pointer_actions"] } },
});

describe("global controls", () => {
  it("only lets registry features marked globalControl be targeted", () => {
    expect([...GLOBAL_CONTROL_FEATURES].sort()).toEqual(["actionsCapture", "agents", "reports"]);
    expect(parseGlobalControlTarget("feature", "agents")).toEqual({ kind: "feature", key: "agents" });
    expect(parseGlobalControlTarget("feature", "devtools")).toBeNull();
    expect(parseGlobalControlTarget("provider", "openrouter")).toBeNull();
    expect(parseGlobalControlTarget("model", "baai/bge-m3")).toEqual({ kind: "model", id: "baai/bge-m3" });
    expect(parseGlobalControlTarget("model", "bad model")).toBeNull();
    expect(parseGlobalControlTarget("org", "x")).toBeNull();
  });

  it("rejects duplicate targets and enabled controls", () => {
    const one = control({ kind: "provider", id: "claude" });
    expect(globalControlsSchema.safeParse([one, one]).success).toBe(false);
    expect(globalControlSchema.safeParse({ ...one, enabled: true }).success).toBe(false);
    expect(globalControlSchema.safeParse({ ...one, notice: "x".repeat(241) }).success).toBe(false);
  });

  it("keeps the policy catalog wire shape unchanged", () => {
    for (const feature of staticPolicyCatalog().features) expect(feature).not.toHaveProperty("globalControl");
  });

  it("applies scope and expiry", () => {
    const everyone = control({ kind: "model", id: "model-a" });
    const except = control({ kind: "model", id: "model-a" }, { scope: { mode: "all_except", orgIds: ["org_valen"] } });
    const expired = control({ kind: "model", id: "model-a" }, { expiresAt: "2026-10-02T12:00:00.000Z" });
    const future = control({ kind: "model", id: "model-a" }, { expiresAt: "2026-10-02T13:00:00.000Z" });
    expect(globalControlApplies(everyone, "org_valen", NOW)).toBe(true);
    expect(globalControlApplies(except, "org_valen", NOW)).toBe(false);
    expect(globalControlApplies(except, "org_other", NOW)).toBe(true);
    expect(globalControlApplies(except, null, NOW)).toBe(true);
    expect(globalControlApplies(expired, "org_other", NOW)).toBe(false);
    expect(globalControlApplies(future, "org_other", NOW)).toBe(true);
  });

  it("sends desktops resolved kills without scope or other organizations", () => {
    const kills = globalKillsFor([
      control({ kind: "provider", id: "claude" }, { scope: { mode: "all_except", orgIds: ["org_a", "org_b"] }, notice: "Back soon." }),
      control({ kind: "feature", key: "agents" }),
    ], "org_c", NOW);
    expect(kills).toEqual([
      { target: { kind: "feature", key: "agents" }, notice: null, expiresAt: null },
      { target: { kind: "provider", id: "claude" }, notice: "Back soon.", expiresAt: null },
    ]);
    expect(JSON.stringify(kills)).not.toContain("org_a");
    expect(globalKillsFor([control({ kind: "provider", id: "claude" }, { scope: { mode: "all_except", orgIds: ["org_a"] } })], "org_a", NOW)).toEqual([]);
    expect(desktopOrgPolicyResponseSchema.parse({ orgPolicy: null })).toEqual({ orgPolicy: null, globalControls: [] });
    expect(desktopOrgPolicyResponseSchema.parse({ orgPolicy: null, globalControls: kills }).globalControls).toHaveLength(2);
  });

  it("returns the same policy when nothing applies", () => {
    expect(effectiveOrgPolicy(policy, [], "org", NOW)).toBe(policy);
    const expired = control({ kind: "feature", key: "agents" }, { expiresAt: "2026-10-01T00:00:00.000Z" });
    expect(effectiveOrgPolicy(policy, [expired], "org", NOW)).toBe(policy);
  });

  it("forces killed features off, including pointer capture for actionsCapture", () => {
    const result = effectiveOrgPolicy(policy, [
      control({ kind: "feature", key: "agents" }),
      control({ kind: "feature", key: "actionsCapture" }),
    ], "org", NOW);
    expect(orgFeatureEnabled(result, "agents")).toBe(false);
    expect(orgFeatureEnabled(result, "actionsCapture")).toBe(false);
    expect(orgFeatureEnabled(result, "reports")).toBe(true);
    expect(result.capture.allowedSources).toEqual(["screen"]);
    expect(result.capture.enabledSources?.value).toEqual(["screen"]);
    expect(orgPolicySchema.safeParse(result).success).toBe(true);
    // Input untouched.
    expect(policy.features.agents).toBe(true);
    expect(policy.capture.allowedSources).toContain("pointer_actions");
  });

  it("narrows an unrestricted capture allowlist when pointer capture is killed", () => {
    const open = orgPolicySchema.parse({ schemaVersion: 1 });
    const result = effectiveOrgPolicy(open, [control({ kind: "feature", key: "actionsCapture" })], "org", NOW);
    expect(result.capture.allowedSources).not.toContain("pointer_actions");
    expect(result.capture.allowedSources).toContain("screen");
  });

  it("removes killed providers and moves a managed provider to the next fallback", () => {
    const result = effectiveOrgPolicy(policy, [control({ kind: "provider", id: "zero-retention" })], "org", NOW);
    expect(result.inference.allowedProviders).toEqual(["confidential", "chatgpt"]);
    expect(result.inference.fallbackProviders).toEqual(["confidential"]);
    expect(result.inference.provider).toEqual({ mode: "locked", value: "confidential" });
  });

  it("turns an unrestricted provider list into the remaining providers", () => {
    const open = orgPolicySchema.parse({ schemaVersion: 1 });
    const result = effectiveOrgPolicy(open, [control({ kind: "provider", id: "claude" })], "org", NOW);
    expect(result.inference.allowedProviders).toEqual(["confidential", "zero-retention", "chatgpt"]);
    expect(result.inference.fallbackProviders).toBeNull();
  });

  it("drops a managed provider when every provider is killed", () => {
    const result = effectiveOrgPolicy(policy, ["confidential", "zero-retention", "chatgpt", "claude"].map((id) =>
      control({ kind: "provider", id } as GlobalControlTarget)), "org", NOW);
    expect(result.inference.allowedProviders).toEqual([]);
    expect(result.inference.provider).toBeUndefined();
  });

  it("removes killed models and managed model settings on them", () => {
    const result = effectiveOrgPolicy(policy, [control({ kind: "model", id: "vendor/model-b" })], "org", NOW);
    expect(result.inference.allowedModels).toEqual(["model-a"]);
    expect(result.inference.transcriptionModel).toBeUndefined();
    const open = orgPolicySchema.parse({ schemaVersion: 1 });
    expect(effectiveOrgPolicy(open, [control({ kind: "model", id: "model-a" })], "org", NOW).inference.allowedModels).toBeNull();
  });

  it("never applies to an excepted organization", () => {
    const except: Partial<GlobalControl> = { scope: { mode: "all_except", orgIds: ["org_valen"] } };
    const result = effectiveOrgPolicy(policy, [
      control({ kind: "feature", key: "agents" }, except),
      control({ kind: "provider", id: "zero-retention" }, except),
    ], "org_valen", NOW);
    expect(result).toBe(policy);
  });

  it("strips legacy slugs of killed features and features that need them", () => {
    const slugs = ["enable-agents", "enable-reports", "enable-skills", "enable-actions-capture"];
    expect(withoutGloballyDisabledSlugs(slugs, [control({ kind: "feature", key: "agents" })], "org", NOW))
      .toEqual(["enable-reports", "enable-skills", "enable-actions-capture"]);
    expect(withoutGloballyDisabledSlugs(slugs, [control({ kind: "model", id: "model-a" })], "org", NOW)).toEqual(slugs);
  });

  it("round-trips the refusal message", () => {
    const message = globallyDisabledMessage({ kind: "provider", id: "zero-retention" }, null);
    expect(message).toBe("globally_disabled: Zero-retention inference is temporarily unavailable.");
    expect(parseGloballyDisabledMessage(message)).toBe("Zero-retention inference is temporarily unavailable.");
    expect(parseGloballyDisabledMessage(globallyDisabledMessage({ kind: "model", id: "m" }, "Back at 3pm."))).toBe("Back at 3pm.");
    expect(parseGloballyDisabledMessage("seat_limit_reached: full")).toBeNull();
    expect(parseGloballyDisabledMessage(undefined)).toBeNull();
  });
});
