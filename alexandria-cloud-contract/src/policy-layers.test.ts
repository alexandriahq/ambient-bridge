import { describe, expect, it } from "vitest";
import { orgPolicySchema, type OrgPolicy, type OrgPolicyInput, type OrgPolicyVersion } from "./org-policy.js";
import {
  ORGANIZATIONS_LAYER_ID,
  PUBLIC_LAYER_ID,
  layeredOrgPolicy,
  mergePolicyChain,
  policyAncestors,
  policyDescendants,
  policyLayerKind,
  policyOverridePaths,
  policyOverrides,
} from "./policy-layers.js";

const policy = (input: Omit<OrgPolicyInput, "schemaVersion">): OrgPolicy => orgPolicySchema.parse({ schemaVersion: 1, ...input });

const version = (id: string, number: number, value: OrgPolicy, publishedAt = "2026-10-01T10:00:00.000Z"): OrgPolicyVersion => ({
  workosOrganizationId: id,
  version: number,
  policy: value,
  reason: "test",
  actor: { kind: "operator", id: "user_1", email: null, client: null },
  publishedAt,
  restoredFromVersion: null,
});

const merge = (...chain: OrgPolicy[]): OrgPolicy => {
  const result = mergePolicyChain(chain);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.policy;
};

describe("policy layer ids", () => {
  it("organizations inherit the organizations layer; layers inherit the product defaults", () => {
    expect(policyAncestors("org_01abc")).toEqual([ORGANIZATIONS_LAYER_ID]);
    expect(policyAncestors(ORGANIZATIONS_LAYER_ID)).toEqual([]);
    expect(policyAncestors(PUBLIC_LAYER_ID)).toEqual([]);
    expect(policyLayerKind(PUBLIC_LAYER_ID)).toBe("defaults");
    expect(policyLayerKind("org_01abc")).toBe("organization");
  });

  it("only the organizations layer reaches organizations; plans inherit Public customers", () => {
    expect(policyDescendants(ORGANIZATIONS_LAYER_ID, ["org_a", "org_b", "plan_plus"])).toEqual(["org_a", "org_b"]);
    expect(policyDescendants(PUBLIC_LAYER_ID, ["org_a", "plan_plus"])).toEqual(["plan_plus"]);
    expect(policyAncestors("plan_plus")).toEqual([PUBLIC_LAYER_ID]);
    expect(policyLayerKind("plan_plus")).toBe("plan");
  });
});

describe("mergePolicyChain", () => {
  it("a child that leaves a setting at the product default inherits the parent's value", () => {
    const parent = policy({
      features: { reports: true },
      inference: { transcriptionModel: { mode: "locked", value: "whisper" }, allowedProviders: ["zero-retention", "chatgpt"] },
      capture: { peopleCanAddRules: false },
    });
    const merged = merge(parent, policy({}));
    expect(merged.features.reports).toBe(true);
    expect(merged.inference.transcriptionModel).toEqual({ mode: "locked", value: "whisper" });
    expect(merged.inference.allowedProviders).toEqual(["zero-retention", "chatgpt"]);
    expect(merged.capture.peopleCanAddRules).toBe(false);
  });

  it("a child's own value wins; lists and managed settings replace, never combine", () => {
    const parent = policy({
      features: { reports: true, agents: true },
      inference: { allowedProviders: ["zero-retention", "chatgpt"], transcriptionModel: { mode: "locked", value: "whisper" } },
    });
    const child = policy({
      features: { reports: false },
      inference: { allowedProviders: ["chatgpt"], transcriptionModel: { mode: "default", value: "parakeet" } },
    });
    const merged = merge(parent, child);
    expect(merged.features).toEqual({ reports: false, agents: true });
    expect(merged.inference.allowedProviders).toEqual(["chatgpt"]);
    expect(merged.inference.transcriptionModel).toEqual({ mode: "default", value: "parakeet" });
  });

  it("nested per-mode settings merge per mode", () => {
    const parent = policy({ inference: { models: { confidential: ["a"], "zero-retention": ["b"] } } });
    const child = policy({ inference: { models: { "zero-retention": ["c"] } } });
    expect(merge(parent, child).inference.models).toEqual({ confidential: ["a"], "zero-retention": ["c"] });
  });

  it("display name and Multiplayer never inherit", () => {
    const parent = policy({ ui: { displayName: "All organizations", banners: [{ id: "notice", tone: "info", title: "Hello" }] }, multiplayer: { preset: "standard" } });
    const merged = merge(parent, policy({}));
    expect(merged.ui.displayName).toBeUndefined();
    expect(merged.multiplayer).toBeNull();
    expect(merged.ui.banners.map((banner) => banner.id)).toEqual(["notice"]);
  });

  it("rejects a combination that is invalid even though each layer is valid", () => {
    const parent = policy({ inference: { allowedProviders: ["chatgpt"] } });
    const child = policy({ inference: { provider: { mode: "locked", value: "confidential" } } });
    const result = mergePolicyChain([parent, child]);
    expect(result.success).toBe(false);
  });
});

describe("policyOverridePaths", () => {
  it("lists only what differs from the product default", () => {
    const paths = policyOverridePaths(policy({ features: { reports: true }, inference: { allowedProviders: ["chatgpt"] } }));
    expect(paths).toEqual([["features", "reports"], ["inference", "allowedProviders"]]);
    expect(policyOverridePaths(policy({}))).toEqual([]);
  });
});

describe("layeredOrgPolicy", () => {
  const layer = version(ORGANIZATIONS_LAYER_ID, 2, policy({ features: { reports: true } }), "2026-10-02T10:00:00.000Z");
  const own = version("org_a", 5, policy({ features: { agents: true } }), "2026-10-01T10:00:00.000Z");

  it("is null when nothing in the chain is published", () => {
    expect(layeredOrgPolicy("org_a", null, [null])).toBeNull();
  });

  it("merges the chain; version is the sum, publishedAt the latest, revision names every layer", () => {
    const effective = layeredOrgPolicy("org_a", own, [layer])!;
    expect(effective.policy.features).toEqual({ reports: true, agents: true });
    expect(effective.version).toBe(7);
    expect(effective.publishedAt).toBe("2026-10-02T10:00:00.000Z");
    expect(effective.revision).toBe(`${ORGANIZATIONS_LAYER_ID}:2+org_a:5`);
    expect(effective.invalidCombination).toBe(false);
  });

  it("an organization with no policy of its own gets the layer's", () => {
    const effective = layeredOrgPolicy("org_b", null, [layer])!;
    expect(effective.policy.features).toEqual({ reports: true });
    expect(effective.own).toBeNull();
    expect(effective.version).toBe(2);
  });

  it("an invalid combination falls back to the target's own policy and says so", () => {
    const narrow = version(ORGANIZATIONS_LAYER_ID, 1, policy({ inference: { allowedProviders: ["chatgpt"] } }));
    const locked = version("org_a", 1, policy({ inference: { provider: { mode: "locked", value: "confidential" } } }));
    const effective = layeredOrgPolicy("org_a", locked, [narrow])!;
    expect(effective.invalidCombination).toBe(true);
    expect(effective.policy.inference.provider?.value).toBe("confidential");
  });
});

describe("policyOverrides", () => {
  const inherited = policy({
    features: { reports: true },
    inference: { allowedProviders: ["zero-retention", "chatgpt"], transcriptionModel: { mode: "locked", value: "whisper" } },
    capture: { peopleCanAddRules: false },
  });

  it("drops what equals the inherited value and keeps the rest", () => {
    const edited = merge(inherited, policy({ features: { agents: true }, inference: { transcriptionModel: { mode: "default", value: "whisper" } } }));
    const own = policyOverrides(edited, inherited);
    expect(own.features).toEqual({ agents: true });
    expect(own.inference.allowedProviders).toBeNull();
    expect(own.inference.transcriptionModel).toEqual({ mode: "default", value: "whisper" });
    expect(own.capture.peopleCanAddRules).toBe(true);
  });

  it("round-trips: merging the overrides back gives the edited policy", () => {
    const edited = merge(inherited, policy({ features: { reports: false }, inference: { models: { confidential: ["a"] } } }));
    expect(merge(inherited, orgPolicySchema.parse(policyOverrides(edited, inherited)))).toEqual(edited);
  });

  it("keeps own-only sections as they are", () => {
    const edited = policy({ ui: { displayName: "Acme" } });
    expect(policyOverrides(edited, policy({ ui: { displayName: "Acme" } })).ui.displayName).toBe("Acme");
  });
});
