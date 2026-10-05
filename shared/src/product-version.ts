/**
 * Product version identity for Ambient Desktop (App + Bridge).
 *
 * Each install stays on the feed it was built for. There is no in-app
 * channel switch:
 *   - `alpha`    — every release shipped so far; keep publishing on `prod`
 *   - `nightly`  — new train (`X.Y.Z-nightly.YYYYMMDD.N`); GitHub Release + `/nightly/`
 *   - `stable`   — new train (`X.Y.Z`); GitHub Release + `/stable/`
 *
 * `experimental` is PR review only — not a user update feed. `local` is
 * unpackaged / QA. The server and the `prod` git line
 * stay the production-tracking path; they are not desktop update channels.
 */

export const AMBIENT_RELEASE_STABLE_CHANNEL = "stable";
export const AMBIENT_RELEASE_NIGHTLY_CHANNEL = "nightly";
export const AMBIENT_RELEASE_ALPHA_CHANNEL = "alpha";
export const AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL = "experimental";
export const AMBIENT_RELEASE_LOCAL_CHANNEL = "local";

/** Feeds an installed build can belong to (no Settings toggle). */
export const AMBIENT_USER_UPDATE_CHANNELS = Object.freeze([
  AMBIENT_RELEASE_STABLE_CHANNEL,
  AMBIENT_RELEASE_NIGHTLY_CHANNEL,
  AMBIENT_RELEASE_ALPHA_CHANNEL,
] as const);

export type AmbientUserUpdateChannel = (typeof AMBIENT_USER_UPDATE_CHANNELS)[number];

export const AMBIENT_RELEASE_CHANNELS = Object.freeze([
  AMBIENT_RELEASE_STABLE_CHANNEL,
  AMBIENT_RELEASE_NIGHTLY_CHANNEL,
  AMBIENT_RELEASE_ALPHA_CHANNEL,
  AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL,
  AMBIENT_RELEASE_LOCAL_CHANNEL,
] as const);

export type AmbientReleaseChannel = (typeof AMBIENT_RELEASE_CHANNELS)[number];

export const AMBIENT_APP_RELEASE_PRODUCT_SLUG = "ambient-app";
export const AMBIENT_BRIDGE_RELEASE_PRODUCT_SLUG = "ambient-bridge";

export const AMBIENT_BRIDGE_IPC_PROTOCOL_VERSION = 1;
export const AMBIENT_BRIDGE_IPC_MIN_PROTOCOL_VERSION = 1;

/**
 * Optional IPC features a Bridge advertises in `bridge.health` `capabilities`.
 * The app sends a feature's new request fields only to a Bridge that lists it;
 * released Bridges (1.0.9) list none and keep their behavior.
 */
export const AMBIENT_BRIDGE_CAPABILITIES = {
  /**
   * Inference requests may carry `inferenceMode` (ADR-0313): the transport for
   * that one request, `confidential` or `zero-retention`. Absent = the Node's
   * assigned mode.
   */
  inferenceMode: "inference.mode",
} as const;

export type AmbientBridgeCapability = (typeof AMBIENT_BRIDGE_CAPABILITIES)[keyof typeof AMBIENT_BRIDGE_CAPABILITIES];

/** Payload field of every `inference.*` request that carries a per-request mode (ADR-0313). */
export const BRIDGE_INFERENCE_MODE_FIELD = "inferenceMode";

export type ParsedProductVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
};

export type ExperimentalBuildStamp = {
  readonly prNumber: string | null;
  readonly runId: string | null;
  readonly attempt: number | null;
};

export type AmbientBridgeHealth = {
  readonly ok: boolean;
  readonly version: string;
  readonly protocolVersion: number;
  /** Optional IPC features (`AMBIENT_BRIDGE_CAPABILITIES`); empty for Bridges that predate the list. */
  readonly capabilities: readonly string[];
};

export class DesktopCompatibilityError extends Error {
  readonly code: "protocol_unsupported" | "invalid_health";

  constructor(code: DesktopCompatibilityError["code"], message: string) {
    super(message);
    this.name = "DesktopCompatibilityError";
    this.code = code;
  }
}

export function parseProductVersion(value: string): ParsedProductVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

/** Shared identity stamped onto every product built by one Experimental PR run. */
export function parseExperimentalBuildStamp(version: string): ExperimentalBuildStamp {
  const parsed = parseProductVersion(version);
  const [channel, prPart, runId, attemptPart, ...extra] = parsed?.prerelease ?? [];
  const prMatch = /^pr([1-9]\d*)$/i.exec(prPart ?? "");
  const validRunId = /^[1-9]\d{0,19}$/.test(runId ?? "");
  const attemptMatch = /^attempt([2-9]|[1-9]\d+)$/.exec(attemptPart ?? "");
  if (
    channel?.toLowerCase() !== AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL
    || !prMatch
    || !validRunId
    || extra.length > 0
    || (attemptPart !== undefined && !attemptMatch)
  ) {
    return { attempt: null, prNumber: null, runId: null };
  }
  return {
    attempt: attemptMatch ? Number(attemptMatch[1]) : null,
    prNumber: prMatch[1] ?? null,
    runId: runId ?? null,
  };
}

/** Base-version-independent key for App/Bridge artifacts from the same PR run. */
export function experimentalBuildPairingKey(version: string): string | null {
  const stamp = parseExperimentalBuildStamp(version);
  if (!stamp.prNumber || !stamp.runId) return null;
  return `${stamp.prNumber}:${stamp.runId}:${stamp.attempt ?? 1}`;
}

export function compareProductVersions(left: string, right: string): number {
  const parsedLeft = parseProductVersion(left);
  const parsedRight = parseProductVersion(right);
  if (!parsedLeft || !parsedRight) return left.localeCompare(right);

  const core = compareNumbers(parsedLeft.major, parsedRight.major)
    || compareNumbers(parsedLeft.minor, parsedRight.minor)
    || compareNumbers(parsedLeft.patch, parsedRight.patch);
  if (core !== 0) return core;
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

export function isProductVersionAtLeast(current: string, minimum: string): boolean {
  return compareProductVersions(current, minimum) >= 0;
}

export function stableCoreVersion(version: string): string | null {
  const parsed = parseProductVersion(version);
  if (!parsed) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

export function isUserUpdateChannel(value: string): value is AmbientUserUpdateChannel {
  return (AMBIENT_USER_UPDATE_CHANNELS as readonly string[]).includes(value);
}

export function parseUserUpdateChannel(value: string | null | undefined): AmbientUserUpdateChannel | null {
  if (!value) return null;
  const facing = userFacingUpdateChannel(value);
  return isUserUpdateChannel(facing) ? facing : null;
}

/** Product name for a version or stored channel. Alpha stays alpha. */
export function userFacingUpdateChannel(value: string): AmbientReleaseChannel {
  const normalized = value.trim().toLowerCase();
  if (normalized === AMBIENT_RELEASE_ALPHA_CHANNEL) return AMBIENT_RELEASE_ALPHA_CHANNEL;
  if (normalized === AMBIENT_RELEASE_NIGHTLY_CHANNEL) return AMBIENT_RELEASE_NIGHTLY_CHANNEL;
  if (normalized === AMBIENT_RELEASE_STABLE_CHANNEL) return AMBIENT_RELEASE_STABLE_CHANNEL;
  if (normalized === AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL) return AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL;
  if (normalized === AMBIENT_RELEASE_LOCAL_CHANNEL || normalized === "dev") {
    return AMBIENT_RELEASE_LOCAL_CHANNEL;
  }
  return inferReleaseChannel(value);
}

/** Railway / electron-updater feed segment. Each train has its own prefix. */
export function canonicalFeedChannel(value: string): string {
  return userFacingUpdateChannel(value);
}

export function inferReleaseChannel(version: string): AmbientReleaseChannel {
  const parsed = parseProductVersion(version);
  if (!parsed) return AMBIENT_RELEASE_ALPHA_CHANNEL;
  const preid = parsed.prerelease[0]?.toLowerCase() ?? "";
  if (preid === AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL) return AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL;
  if (preid === AMBIENT_RELEASE_LOCAL_CHANNEL || preid === "dev") return AMBIENT_RELEASE_LOCAL_CHANNEL;
  if (preid === AMBIENT_RELEASE_NIGHTLY_CHANNEL) return AMBIENT_RELEASE_NIGHTLY_CHANNEL;
  if (preid === AMBIENT_RELEASE_ALPHA_CHANNEL) return AMBIENT_RELEASE_ALPHA_CHANNEL;
  if (parsed.prerelease.length === 0) return AMBIENT_RELEASE_STABLE_CHANNEL;
  return AMBIENT_RELEASE_ALPHA_CHANNEL;
}

export function isExperimentalReleaseChannel(value: string): boolean {
  return value.trim().toLowerCase() === AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL;
}

export function resolveReleaseChannel(input: {
  readonly currentVersion: string;
  readonly explicitChannel?: string | null;
}): string {
  const explicit = input.explicitChannel?.trim();
  if (explicit) return canonicalFeedChannel(explicit);
  return canonicalFeedChannel(inferReleaseChannel(input.currentVersion));
}

export function githubReleaseTag(
  productSlug: typeof AMBIENT_APP_RELEASE_PRODUCT_SLUG | typeof AMBIENT_BRIDGE_RELEASE_PRODUCT_SLUG,
  version: string,
): string {
  const core = stableCoreVersion(version);
  if (!core) {
    throw new Error(`Cannot form a GitHub release tag from ${JSON.stringify(version)}.`);
  }
  const facing = inferReleaseChannel(version);
  if (facing === AMBIENT_RELEASE_STABLE_CHANNEL) {
    return `${productSlug}-v${core}`;
  }
  return `${productSlug}-v${version.replace(/^v/, "")}`;
}

export function parseBridgeHealth(value: unknown): AmbientBridgeHealth {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DesktopCompatibilityError("invalid_health", "Ambient Bridge health must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "string" || record.version.trim() === "") {
    throw new DesktopCompatibilityError("invalid_health", "Ambient Bridge health is missing a version.");
  }
  const protocolVersion = record.protocolVersion === undefined
    ? AMBIENT_BRIDGE_IPC_MIN_PROTOCOL_VERSION
    : record.protocolVersion;
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion) || protocolVersion < 1) {
    throw new DesktopCompatibilityError(
      "invalid_health",
      "Ambient Bridge health protocolVersion must be a positive integer.",
    );
  }
  const capabilities = Array.isArray(record.capabilities)
    ? [...new Set(record.capabilities.filter((entry): entry is string =>
      typeof entry === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(entry)))].slice(0, 64)
    : [];
  return {
    capabilities,
    ok: record.ok !== false,
    protocolVersion,
    version: record.version.trim(),
  };
}

/** True when a parsed Bridge health lists `capability`. */
export function bridgeHealthSupports(
  health: Pick<AmbientBridgeHealth, "capabilities"> | null | undefined,
  capability: AmbientBridgeCapability,
): boolean {
  return health?.capabilities.includes(capability) === true;
}

export function assertBridgeProtocolCompatible(health: Pick<AmbientBridgeHealth, "protocolVersion">): void {
  if (health.protocolVersion > AMBIENT_BRIDGE_IPC_PROTOCOL_VERSION) {
    throw new DesktopCompatibilityError(
      "protocol_unsupported",
      `Ambient Bridge protocol ${health.protocolVersion} is newer than this Ambient build (speaks ${AMBIENT_BRIDGE_IPC_PROTOCOL_VERSION}). Update Ambient.`,
    );
  }
  if (health.protocolVersion < AMBIENT_BRIDGE_IPC_MIN_PROTOCOL_VERSION) {
    throw new DesktopCompatibilityError(
      "protocol_unsupported",
      `Ambient Bridge protocol ${health.protocolVersion} is too old for this Ambient build. Update Ambient Bridge.`,
    );
  }
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const compared = comparePrereleasePart(leftPart, rightPart);
    if (compared !== 0) return compared;
  }
  return 0;
}

function comparePrereleasePart(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return compareNumbers(Number(left), Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left.localeCompare(right);
}

function compareNumbers(left: number, right: number): number {
  if (left === right) return 0;
  return left > right ? 1 : -1;
}
