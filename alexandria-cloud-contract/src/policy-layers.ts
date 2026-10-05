import type { z } from "zod";
import { emptyOrgPolicy, orgPolicySchema, type OrgPolicy, type OrgPolicyVersion } from "./org-policy.js";
import { isPlanId } from "./plans.js";

// Policy layers: defaults that organization policies inherit from. A layer is
// a policy document stored and published exactly like an organization's
// (same store, same draft → publish → rollback, same audit), under a reserved
// id that can never be a WorkOS organization id (those start with `org_`).
// Each document only overrides its parent where it differs from the product
// default; everything else comes from the layer above.

/** `plan`: a subscription plan (ADR-0324); it inherits Public customers. */
export const POLICY_LAYER_KINDS = ["defaults", "plan", "organization"] as const;
export type PolicyLayerKind = (typeof POLICY_LAYER_KINDS)[number];

export interface PolicyLayerDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Next layer up; null = inherits from the product defaults. */
  readonly parentId: string | null;
}

/** Every organization inherits this layer. */
export const ORGANIZATIONS_LAYER_ID = "layer_organizations";
/** People without an organization (the public Node); every plan inherits it. */
export const PUBLIC_LAYER_ID = "layer_public";

export const POLICY_LAYERS: readonly PolicyLayerDefinition[] = [
  {
    id: ORGANIZATIONS_LAYER_ID,
    name: "All organizations",
    description: "Defaults every organization inherits. An organization overrides only what it sets.",
    parentId: null,
  },
  {
    id: PUBLIC_LAYER_ID,
    name: "Public customers",
    description: "Defaults for people without an organization.",
    parentId: null,
  },
];

export function policyLayer(id: string): PolicyLayerDefinition | null {
  return POLICY_LAYERS.find((layer) => layer.id === id) ?? null;
}

export function policyLayerKind(id: string): PolicyLayerKind {
  if (policyLayer(id)) return "defaults";
  return isPlanId(id) ? "plan" : "organization";
}

/**
 * Layers a policy target inherits from, nearest first. Organizations inherit
 * the organizations layer; layers follow their parent chain.
 */
export function policyAncestors(id: string): readonly string[] {
  const layer = policyLayer(id);
  const parent = layer ? layer.parentId : isPlanId(id) ? PUBLIC_LAYER_ID : ORGANIZATIONS_LAYER_ID;
  return parent ? [parent, ...policyAncestors(parent)] : [];
}

/** Ids of every target that inherits from `layerId`, among the layers and the given targets (organizations, plans). */
export function policyDescendants(layerId: string, targetIds: readonly string[]): readonly string[] {
  const candidates = [...new Set([...POLICY_LAYERS.map((layer) => layer.id), ...targetIds])];
  return candidates.filter((id) => id !== layerId && policyAncestors(id).includes(layerId));
}

/**
 * Sections that never inherit: they describe one target, not a default.
 * - `ui.displayName` names the organization in "Managed by …" labels.
 * - `multiplayer` is compiled per organization and pushed to its Node.
 */
const LOCAL_PATHS: readonly (readonly string[])[] = [["ui", "displayName"], ["multiplayer"]];

const isLocal = (path: readonly string[]) =>
  LOCAL_PATHS.some((local) => local.length === path.length && local.every((key, index) => key === path[index]));

type Json = unknown;

const isPlainObject = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `{ mode, value }`: a managed setting is one value, never merged field by field. */
const isManaged = (value: Json) =>
  isPlainObject(value) && Object.keys(value).length === 2 && "mode" in value && "value" in value;

function equal(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => equal(a[key], b[key]));
  }
  return false;
}

/**
 * The child's value where it differs from the product default, else the
 * parent's. Objects merge key by key; lists and managed settings are whole
 * values (a child list replaces the parent's).
 */
function mergeValue(parent: Json, child: Json, empty: Json, path: readonly string[]): Json {
  if (isLocal(path)) return child;
  if (isPlainObject(empty) && !isManaged(empty) && isPlainObject(child) && !isManaged(child)) {
    const parentObject = isPlainObject(parent) ? parent : {};
    const keys = new Set([...Object.keys(parentObject), ...Object.keys(child), ...Object.keys(empty)]);
    const result: Record<string, Json> = {};
    for (const key of keys) {
      const value = mergeValue(parentObject[key], child[key], empty[key], [...path, key]);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  // Records without defaults (features, data types): absent = inherit.
  if (empty === undefined && isPlainObject(child) && !isManaged(child) && isPlainObject(parent) && !isManaged(parent)) {
    const keys = new Set([...Object.keys(parent), ...Object.keys(child)]);
    const result: Record<string, Json> = {};
    for (const key of keys) {
      const value = mergeValue(parent[key], child[key], undefined, [...path, key]);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  if (child !== undefined && !equal(child, empty)) return child;
  return parent !== undefined ? parent : child;
}

/** Fields `policy` sets itself: where it differs from the product default. */
export function policyOverridePaths(policy: OrgPolicy): string[][] {
  const paths: string[][] = [];
  const walk = (value: Json, empty: Json, path: string[]) => {
    if (isPlainObject(value) && !isManaged(value) && (isPlainObject(empty) || empty === undefined)) {
      const emptyObject = isPlainObject(empty) ? empty : {};
      for (const key of new Set([...Object.keys(value), ...Object.keys(emptyObject)])) {
        walk(value[key], emptyObject[key], [...path, key]);
      }
      return;
    }
    if (value !== undefined && !equal(value, empty)) paths.push(path);
  };
  walk(policy, emptyOrgPolicy(), []);
  return paths;
}

/**
 * Merge a chain of policies, farthest ancestor first and the target last. The
 * result is parsed again: a combination can be invalid even when every layer
 * is valid on its own (a parent narrows the providers a child picks from).
 */
export function mergePolicyChain(chain: readonly OrgPolicy[]): { success: true; policy: OrgPolicy } | { success: false; error: z.ZodError } {
  const empty = emptyOrgPolicy();
  let merged: Json = empty;
  for (const policy of chain) merged = mergeValue(merged, policy, empty, []);
  const parsed = orgPolicySchema.safeParse(merged);
  return parsed.success ? { success: true, policy: parsed.data } : { success: false, error: parsed.error };
}

export interface EffectivePolicyLayer {
  readonly id: string;
  readonly version: number;
  readonly publishedAt: string;
}

/**
 * The policy a target actually gets: its own published version merged over
 * its ancestors' published versions. `version` is the sum of the layer
 * versions (every publish or rollback in the chain raises it, which is what
 * desktop change detection reads); `publishedAt` is the latest of them.
 */
export interface LayeredOrgPolicy {
  readonly targetId: string;
  readonly own: OrgPolicyVersion | null;
  readonly layers: readonly EffectivePolicyLayer[];
  readonly policy: OrgPolicy;
  readonly version: number;
  readonly publishedAt: string;
  /** Stable key for caches and ETags: `<id>:<version>` per layer, nearest last. */
  readonly revision: string;
  /** The layers did not combine into a valid policy; `policy` is the target's own (or nearest) one. */
  readonly invalidCombination: boolean;
}

/**
 * `ancestors` nearest first, as `policyAncestors` returns them, with each
 * one's published version (null = nothing published). Null when nothing in the
 * chain is published. An invalid combination falls back to the target's own
 * policy (or the nearest valid layer), never to a half-merged document.
 */
export function layeredOrgPolicy(
  targetId: string,
  own: OrgPolicyVersion | null,
  ancestors: readonly (OrgPolicyVersion | null)[],
): LayeredOrgPolicy | null {
  const published = [...ancestors].reverse().filter((version): version is OrgPolicyVersion => version !== null);
  const chain = own ? [...published, own] : published;
  if (chain.length === 0) return null;
  // The target is always last, so its own-only sections (display name,
  // Multiplayer) never come from a layer, even when it has no policy yet.
  const merged = mergePolicyChain([...published.map((version) => version.policy), own?.policy ?? emptyOrgPolicy()]);
  return {
    targetId,
    own,
    layers: chain.map((version) => ({ id: version.workosOrganizationId, version: version.version, publishedAt: version.publishedAt })),
    policy: merged.success ? merged.policy : (own ?? chain[chain.length - 1]!).policy,
    invalidCombination: !merged.success,
    version: chain.reduce((sum, version) => sum + version.version, 0),
    publishedAt: chain.map((version) => version.publishedAt).sort().at(-1)!,
    revision: chain.map((version) => `${version.workosOrganizationId}:${version.version}`).join("+"),
  };
}

/**
 * The inverse of merging: what `policy` must store to come out as itself when
 * merged over `inherited`. Values equal to the inherited ones go back to the
 * product default (= inherit); everything else is kept. Not re-parsed: the
 * caller validates (the result is the target's own document).
 */
export function policyOverrides(policy: OrgPolicy, inherited: OrgPolicy): OrgPolicy {
  const strip = (value: Json, parent: Json, empty: Json, path: readonly string[]): Json => {
    if (isLocal(path)) return value;
    const recordLike = isPlainObject(value) && !isManaged(value) && (empty === undefined || (isPlainObject(empty) && !isManaged(empty)));
    if (recordLike) {
      const valueObject = value as Record<string, Json>;
      const parentObject = isPlainObject(parent) ? parent : {};
      const emptyObject = isPlainObject(empty) ? empty : {};
      const result: Record<string, Json> = {};
      for (const key of Object.keys(valueObject)) {
        const next = strip(valueObject[key], parentObject[key], emptyObject[key], [...path, key]);
        if (next !== undefined) result[key] = next;
      }
      // A record without defaults that ends up empty is the same as absent.
      return empty === undefined && Object.keys(result).length === 0 && parent !== undefined ? undefined : result;
    }
    return parent !== undefined && equal(value, parent) ? empty : value;
  };
  return strip(policy, inherited, emptyOrgPolicy(), []) as OrgPolicy;
}

/** Value at `path`, or undefined. */
export function policyValueAt(policy: unknown, path: readonly (string | number)[]): unknown {
  let value: unknown = policy;
  for (const key of path) value = isPlainObject(value) || Array.isArray(value) ? (value as Record<string | number, unknown>)[key] : undefined;
  return value;
}

/** True when `policy` (a target's own document) sets `path` itself rather than leaving it to the layers above. */
export function policySetsPath(policy: OrgPolicy, path: readonly (string | number)[]): boolean {
  const own = policyValueAt(policy, path);
  return own !== undefined && !equal(own, policyValueAt(emptyOrgPolicy(), path));
}
