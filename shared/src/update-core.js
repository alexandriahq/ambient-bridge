// Shared auto-update core for Ambient App and Ambient Bridge.
// Plain JS + update-core.d.ts (like compact-auth-window) so both the Vite-built
// app main process and the tsc-built bridge main process can consume it at
// runtime. Product-specific modules bind these helpers to their product slug.

export const AMBIENT_UPDATE_DEFAULT_BASE_URL = "https://api.alexandria.so";
export const AMBIENT_RELEASE_DEFAULT_CHANNEL = "alpha";
export const AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL = "experimental";
export const AMBIENT_RELEASE_PLATFORM = "darwin";
export const AMBIENT_RELEASE_ARCH = "arm64";
export const AMBIENT_WINDOWS_RELEASE_PLATFORM = "win32";
export const AMBIENT_WINDOWS_RELEASE_ARCH = "x64";

export function productUpdateFeedUrl(input) {
  const channel = input.channel ?? AMBIENT_RELEASE_DEFAULT_CHANNEL;
  const arch = input.arch ?? AMBIENT_RELEASE_ARCH;
  const platform = input.platform ?? AMBIENT_RELEASE_PLATFORM;
  const versionSegment = input.version ? `${encodeURIComponent(input.version)}/` : "";
  return new URL(
    `/updates/apps/${input.productSlug}/${channel}/${platform}/${arch}/${versionSegment}`,
    normalizedBaseUrl(input.baseUrl),
  ).toString();
}

export function productReleaseListUrl(input) {
  const channel = input.channel ?? AMBIENT_RELEASE_DEFAULT_CHANNEL;
  const arch = input.arch ?? AMBIENT_RELEASE_ARCH;
  const platform = input.platform ?? AMBIENT_RELEASE_PLATFORM;
  return new URL(
    `/releases/apps/${input.productSlug}/${channel}/${platform}/${arch}`,
    normalizedBaseUrl(input.baseUrl),
  ).toString();
}

export function updaterUnavailableReason(input) {
  if (!input.isPackaged) return "Updates are unavailable in development builds.";
  if (input.localQaBuild === true) {
    return "Updates are disabled for local QA builds.";
  }
  if (
    input.platform === AMBIENT_WINDOWS_RELEASE_PLATFORM
    && input.channel === AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL
    && !input.version
  ) {
    return "Automatic updates are disabled for unsigned experimental Windows builds.";
  }
  if (isSupportedReleaseTarget(input.platform, input.arch)) return null;
  if (input.platform === AMBIENT_RELEASE_PLATFORM) return "Updates are only configured for macOS arm64 builds.";
  if (input.platform === AMBIENT_WINDOWS_RELEASE_PLATFORM) return "Updates are only configured for Windows x64 builds.";
  return "Updates are only available for packaged macOS arm64 and Windows x64 builds.";
}

export function normalizeDownloadPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function sanitizedDiagnosticUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return { origin: url.origin, pathname: url.pathname };
  } catch {
    return { origin: "invalid", pathname: "" };
  }
}

export function boundedDiagnosticMessage(value) {
  return value.trim().slice(0, 500);
}

// Metadata-only snapshot of an update status: channel, versions, flags,
// URL origin/path, and bounded error strings — never full URLs or payloads.
export function sanitizedUpdateDiagnostics(status) {
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

export function parseReleaseListResponse(input) {
  const body = record(input.body, "release list response");
  const productSlug = productSlugFromResponse(body, input.productSlug);
  const releases = array(body.releases, "release list response releases")
    .map((release) => parseRelease(release, productSlug))
    .filter((release) => release.channel === input.channel && release.platform === input.platform && release.arch === input.arch);
  return {
    channel: input.channel,
    platform: input.platform,
    arch: input.arch,
    currentVersion: input.currentVersion,
    releasesUrl: input.releasesUrl,
    builds: releases,
  };
}

export function localReleaseBuildsSnapshot(input) {
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

function isSupportedReleaseTarget(platform, arch) {
  return (platform === AMBIENT_RELEASE_PLATFORM && arch === AMBIENT_RELEASE_ARCH)
    || (platform === AMBIENT_WINDOWS_RELEASE_PLATFORM && arch === AMBIENT_WINDOWS_RELEASE_ARCH);
}

function parseRelease(value, defaultProductSlug) {
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
  };
}

function productSlugFromResponse(body, fallbackSlug) {
  if (typeof body.product === "object" && body.product !== null && !Array.isArray(body.product)) {
    return optionalStringValue(body.product.slug, "release product slug") ?? fallbackSlug;
  }
  return fallbackSlug;
}

function releaseBuildKey(input) {
  if (input.id) return `id:${input.id}`;
  return `release:${input.productSlug}:${input.channel}:${input.platform}:${input.arch}:${input.version}`;
}

function parseArtifact(value) {
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

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object.`);
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}: expected array.`);
  return value;
}

function stringValue(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}: expected non-empty string.`);
  }
  return value;
}

function optionalStringValue(value, label) {
  if (value === undefined || value === null) return null;
  return stringValue(value, label);
}

function positiveInteger(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}: expected positive integer.`);
  }
  return value;
}

function normalizedBaseUrl(rawValue) {
  const url = new URL(rawValue);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}
