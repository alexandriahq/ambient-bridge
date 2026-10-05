// Shared auto-update core for Ambient App and Ambient Bridge.
// Authored in TypeScript and bundled into each product's Vite Electron main
// entry. Product-specific modules bind these helpers to their product slug.

import {
  AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL as PRODUCT_EXPERIMENTAL_CHANNEL,
  AMBIENT_RELEASE_LOCAL_CHANNEL as PRODUCT_LOCAL_CHANNEL,
  AMBIENT_RELEASE_NIGHTLY_CHANNEL as PRODUCT_NIGHTLY_CHANNEL,
  AMBIENT_RELEASE_STABLE_CHANNEL as PRODUCT_STABLE_CHANNEL,
  canonicalFeedChannel,
  experimentalBuildPairingKey,
  inferReleaseChannel,
  isExperimentalReleaseChannel,
  resolveReleaseChannel,
  userFacingUpdateChannel,
} from "./product-version.js";

export const AMBIENT_UPDATE_DEFAULT_BASE_URL = "https://api.alexandria.so";
/** Railway feed segment for already-shipped installs. */
export const AMBIENT_RELEASE_DEFAULT_CHANNEL = "alpha";
export const AMBIENT_RELEASE_STABLE_CHANNEL = PRODUCT_STABLE_CHANNEL;
export const AMBIENT_RELEASE_NIGHTLY_CHANNEL = PRODUCT_NIGHTLY_CHANNEL;
export const AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL = PRODUCT_EXPERIMENTAL_CHANNEL;
export const AMBIENT_RELEASE_LOCAL_CHANNEL = PRODUCT_LOCAL_CHANNEL;
export {
  canonicalFeedChannel,
  experimentalBuildPairingKey,
  inferReleaseChannel,
  isExperimentalReleaseChannel,
  resolveReleaseChannel,
  userFacingUpdateChannel,
};
export const AMBIENT_RELEASE_PLATFORM = "darwin";
export const AMBIENT_RELEASE_ARCH = "arm64";
export const AMBIENT_WINDOWS_RELEASE_PLATFORM = "win32";
export const AMBIENT_WINDOWS_RELEASE_ARCH = "x64";
export const AMBIENT_LINUX_RELEASE_PLATFORM = "linux";
export const AMBIENT_LINUX_RELEASE_ARCH = "x64";

export interface AmbientProductUpdateStatus {
  /** This automatic check/download may keep transport failures quiet while retries remain. */
  readonly backgroundCheck?: boolean;
  readonly channel: string;
  readonly checking: boolean;
  readonly currentVersion: string;
  readonly downloaded: boolean;
  readonly downloading: boolean;
  readonly enabled: boolean;
  readonly feedUrl: string | null;
  readonly latestVersion?: string;
  readonly reason?: string;
  readonly releaseNotesUrl?: string | null;
  readonly downloadPercent?: number | null;
  readonly lastCheckedAtMs?: number;
  readonly lastUpdatedAtMs?: number;
  readonly updateAvailable: boolean;
  readonly updateError?: string;
  /** True after the user starts install/restart and the process is still here. */
  readonly installing?: boolean;
}

export interface AmbientReleaseArtifactSummary {
  readonly kind: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly sha512: string | null;
  readonly downloadUrl: string;
  readonly updateUrl: string;
}

export interface AmbientReleaseBuildSummary {
  readonly id: string | null;
  readonly productSlug: string;
  readonly releaseKey: string;
  readonly version: string;
  readonly channel: string;
  readonly platform: string;
  readonly arch: string;
  readonly appId: string;
  readonly commitSha: string;
  readonly notes: string | null;
  readonly releasedAt: string;
  readonly artifacts: readonly AmbientReleaseArtifactSummary[];
  readonly updateMetadata?: {
    readonly ambientContextVault?: unknown;
  } | null;
}

export interface AmbientReleaseBuildsSnapshot {
  readonly channel: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
  readonly releasesUrl: string | null;
  readonly builds: readonly AmbientReleaseBuildSummary[];
}

/** Experimental App row with the matching Bridge version when one is published. */
export interface AmbientExperimentalBuildSummary extends AmbientReleaseBuildSummary {
  readonly companionAvailable: boolean;
  readonly companionBridgeVersion: string | null;
}

export interface AmbientExperimentalBuildsSnapshot extends Omit<AmbientReleaseBuildsSnapshot, "builds"> {
  readonly builds: readonly AmbientExperimentalBuildSummary[];
}

export function productUpdateFeedUrl(input: {
  readonly productSlug: string;
  readonly baseUrl: string;
  readonly channel?: string;
  readonly arch?: string;
  readonly platform?: NodeJS.Platform;
  readonly version?: string;
}): string {
  const channel = input.channel ?? AMBIENT_RELEASE_DEFAULT_CHANNEL;
  const arch = input.arch ?? AMBIENT_RELEASE_ARCH;
  const platform = input.platform ?? AMBIENT_RELEASE_PLATFORM;
  const versionSegment = input.version ? `${encodeURIComponent(input.version)}/` : "";
  return new URL(
    `/updates/apps/${input.productSlug}/${channel}/${platform}/${arch}/${versionSegment}`,
    normalizedBaseUrl(input.baseUrl),
  ).toString();
}

export function productReleaseListUrl(input: {
  readonly productSlug: string;
  readonly baseUrl: string;
  readonly channel?: string;
  readonly arch?: string;
  readonly platform?: NodeJS.Platform;
}): string {
  const channel = input.channel ?? AMBIENT_RELEASE_DEFAULT_CHANNEL;
  const arch = input.arch ?? AMBIENT_RELEASE_ARCH;
  const platform = input.platform ?? AMBIENT_RELEASE_PLATFORM;
  return new URL(
    `/releases/apps/${input.productSlug}/${channel}/${platform}/${arch}`,
    normalizedBaseUrl(input.baseUrl),
  ).toString();
}

/** Human changelog page for the updater's "See what has changed" action. */
export function productChangelogUrl(input: {
  readonly productSlug: string;
  readonly baseUrl: string;
  readonly channel?: string;
  readonly arch?: string;
  readonly platform?: NodeJS.Platform;
}): string {
  const channel = input.channel ?? AMBIENT_RELEASE_DEFAULT_CHANNEL;
  const arch = input.arch ?? AMBIENT_RELEASE_ARCH;
  const platform = input.platform ?? AMBIENT_RELEASE_PLATFORM;
  return new URL(
    `/changelog/apps/${input.productSlug}/${channel}/${platform}/${arch}`,
    normalizedBaseUrl(input.baseUrl),
  ).toString();
}

export function updaterUnavailableReason(input: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly localQaBuild?: boolean;
  readonly channel?: string;
  readonly version?: string;
}): string | null {
  if (!input.isPackaged) return "Updates are unavailable in development builds.";
  if (input.localQaBuild === true) {
    return "Updates are disabled for local QA builds.";
  }
  if (input.channel === AMBIENT_RELEASE_LOCAL_CHANNEL) {
    return "Updates are unavailable in local builds.";
  }
  if (input.channel && isExperimentalReleaseChannel(input.channel)) {
    return "Automatic updates are disabled for Experimental builds. Install a specific Experimental build from Settings → Dev.";
  }
  if (isSupportedReleaseTarget(input.platform, input.arch)) return null;
  if (input.platform === AMBIENT_RELEASE_PLATFORM) return "Updates are only configured for macOS arm64 builds.";
  if (input.platform === AMBIENT_WINDOWS_RELEASE_PLATFORM) return "Updates are only configured for Windows x64 builds.";
  if (input.platform === AMBIENT_LINUX_RELEASE_PLATFORM) return "Updates are only configured for Linux x64 builds.";
  return "Updates are only available for packaged macOS arm64, Windows x64, and Linux x64 builds.";
}

export function normalizeDownloadPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function sanitizedDiagnosticUrl(
  value: string | null,
): { readonly origin: string; readonly pathname: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return { origin: url.origin, pathname: url.pathname };
  } catch {
    return { origin: "invalid", pathname: "" };
  }
}

export function boundedDiagnosticMessage(value: string): string {
  return value.trim().slice(0, 500);
}

// Metadata-only snapshot of an update status: channel, versions, flags,
// URL origin/path, and bounded error strings — never full URLs or payloads.
export function sanitizedUpdateDiagnostics(
  status: AmbientProductUpdateStatus,
): Record<string, string | number | boolean | null | undefined> {
  const feed = sanitizedDiagnosticUrl(status.feedUrl);
  const releaseNotes = sanitizedDiagnosticUrl(status.releaseNotesUrl ?? null);
  return {
    channel: status.channel,
    currentVersion: status.currentVersion,
    latestVersion: status.latestVersion ?? null,
    enabled: status.enabled,
    checking: status.checking,
    downloaded: status.downloaded,
    downloading: status.downloading,
    downloadPercent: status.downloadPercent ?? null,
    installing: status.installing === true,
    updateAvailable: status.updateAvailable,
    updateError: status.updateError ? boundedDiagnosticMessage(status.updateError) : null,
    reason: status.reason ? boundedDiagnosticMessage(status.reason) : null,
    feedOrigin: feed?.origin ?? null,
    feedPath: feed?.pathname ?? null,
    releaseNotesOrigin: releaseNotes?.origin ?? null,
    releaseNotesPath: releaseNotes?.pathname ?? null,
    lastCheckedAtMs: status.lastCheckedAtMs ?? null,
    lastUpdatedAtMs: status.lastUpdatedAtMs ?? null,
  };
}

export function parseReleaseListResponse(input: {
  readonly productSlug: string;
  readonly channel: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
  readonly releasesUrl: string;
  readonly body: unknown;
}): AmbientReleaseBuildsSnapshot {
  const body = record(input.body, "release list response");
  const productSlug = productSlugFromResponse(body, input.productSlug);
  const releases = array(body.releases, "release list response releases")
    .map((release) => parseRelease(release, productSlug))
    .filter((release) => (
      release.channel === input.channel
      && release.platform === input.platform
      && release.arch === input.arch
    ));
  return {
    channel: input.channel,
    platform: input.platform,
    arch: input.arch,
    currentVersion: input.currentVersion,
    releasesUrl: input.releasesUrl,
    builds: releases,
  };
}

export function localReleaseBuildsSnapshot(input: {
  readonly isPackaged: boolean;
  readonly localBuild?: boolean;
  readonly channel: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
}): AmbientReleaseBuildsSnapshot | null {
  if (input.isPackaged && input.localBuild !== true) return null;
  return {
    channel: input.channel,
    platform: input.platform,
    arch: input.arch,
    currentVersion: input.currentVersion,
    releasesUrl: null,
    builds: [],
  };
}

export function pairExperimentalAppBuilds(input: {
  readonly appBuilds: readonly AmbientReleaseBuildSummary[];
  readonly bridgeBuilds: readonly AmbientReleaseBuildSummary[];
}): readonly AmbientExperimentalBuildSummary[] {
  const bridgeByVersion = new Map<string, AmbientReleaseBuildSummary>();
  const bridgeByPairingKey = new Map<string, AmbientReleaseBuildSummary>();
  for (const build of input.bridgeBuilds) {
    if (!bridgeByVersion.has(build.version)) {
      bridgeByVersion.set(build.version, build);
    }
    const pairingKey = experimentalBuildPairingKey(build.version);
    if (pairingKey && !bridgeByPairingKey.has(pairingKey)) {
      bridgeByPairingKey.set(pairingKey, build);
    }
  }
  return input.appBuilds.map((appBuild) => {
    const pairingKey = experimentalBuildPairingKey(appBuild.version);
    const companion = (pairingKey ? bridgeByPairingKey.get(pairingKey) : undefined)
      ?? bridgeByVersion.get(appBuild.version)
      ?? null;
    return {
      ...appBuild,
      companionAvailable: companion !== null,
      companionBridgeVersion: companion?.version ?? null,
    };
  });
}

function isSupportedReleaseTarget(platform: NodeJS.Platform | string, arch: string): boolean {
  return (platform === AMBIENT_RELEASE_PLATFORM && arch === AMBIENT_RELEASE_ARCH)
    || (platform === AMBIENT_WINDOWS_RELEASE_PLATFORM && arch === AMBIENT_WINDOWS_RELEASE_ARCH)
    || (platform === AMBIENT_LINUX_RELEASE_PLATFORM && arch === AMBIENT_LINUX_RELEASE_ARCH);
}

function parseRelease(value: unknown, defaultProductSlug: string): AmbientReleaseBuildSummary {
  const release = record(value, "release");
  const id = optionalStringValue(release.id, "release id");
  const productSlug = optionalStringValue(release.productSlug, "release productSlug") ?? defaultProductSlug;
  const version = stringValue(release.version, "release version");
  const channel = stringValue(release.channel, "release channel");
  const platform = stringValue(release.platform, "release platform");
  const arch = stringValue(release.arch, "release arch");
  return {
    id,
    productSlug,
    releaseKey: releaseBuildKey({ arch, channel, id, productSlug, version, platform }),
    version,
    channel,
    platform,
    arch,
    appId: stringValue(release.appId, "release appId"),
    commitSha: stringValue(release.commitSha, "release commitSha"),
    notes: release.notes === null ? null : optionalStringValue(release.notes, "release notes"),
    releasedAt: stringValue(release.releasedAt, "release releasedAt"),
    artifacts: array(release.artifacts, "release artifacts").map(parseArtifact),
    updateMetadata: parseOptionalUpdateMetadata(release.updateMetadata),
  };
}

function parseOptionalUpdateMetadata(value: unknown): AmbientReleaseBuildSummary["updateMetadata"] {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as { readonly ambientContextVault?: unknown };
}

function productSlugFromResponse(body: Record<string, unknown>, fallbackSlug: string): string {
  if (typeof body.product === "object" && body.product !== null && !Array.isArray(body.product)) {
    return optionalStringValue((body.product as Record<string, unknown>).slug, "release product slug") ?? fallbackSlug;
  }
  return fallbackSlug;
}

function releaseBuildKey(input: {
  readonly id: string | null;
  readonly productSlug: string;
  readonly channel: string;
  readonly platform: string;
  readonly arch: string;
  readonly version: string;
}): string {
  if (input.id) return `id:${input.id}`;
  return `release:${input.productSlug}:${input.channel}:${input.platform}:${input.arch}:${input.version}`;
}

function parseArtifact(value: unknown): AmbientReleaseArtifactSummary {
  const artifact = record(value, "release artifact");
  return {
    kind: stringValue(artifact.kind, "release artifact kind"),
    fileName: stringValue(artifact.fileName, "release artifact fileName"),
    contentType: stringValue(artifact.contentType, "release artifact contentType"),
    sizeBytes: positiveInteger(artifact.sizeBytes, "release artifact sizeBytes"),
    sha256: stringValue(artifact.sha256, "release artifact sha256"),
    sha512: artifact.sha512 === null ? null : optionalStringValue(artifact.sha512, "release artifact sha512"),
    downloadUrl: stringValue(artifact.downloadUrl, "release artifact downloadUrl"),
    updateUrl: stringValue(artifact.updateUrl, "release artifact updateUrl"),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}: expected array.`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}: expected non-empty string.`);
  }
  return value;
}

function optionalStringValue(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return stringValue(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}: expected positive integer.`);
  }
  return value;
}

function normalizedBaseUrl(rawValue: string): string {
  const url = new URL(rawValue);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}
