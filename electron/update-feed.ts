// Thin product binding over @ambient/shared/update-core: Ambient App and
// Ambient Bridge share one implementation of feed/release URLs, updater
// availability, and release-list parsing; only the product slug differs.
import {
  AMBIENT_RELEASE_ARCH,
  AMBIENT_RELEASE_DEFAULT_CHANNEL,
  AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL,
  AMBIENT_RELEASE_PLATFORM,
  AMBIENT_UPDATE_DEFAULT_BASE_URL,
  AMBIENT_WINDOWS_RELEASE_ARCH,
  AMBIENT_WINDOWS_RELEASE_PLATFORM,
  parseReleaseListResponse,
  productReleaseListUrl,
  productUpdateFeedUrl,
  updaterUnavailableReason,
  type AmbientReleaseBuildsSnapshot,
} from "@ambient/shared/update-core";

export const BRIDGE_RELEASE_PRODUCT_SLUG = "ambient-bridge";
export const BRIDGE_RELEASE_DEFAULT_CHANNEL = AMBIENT_RELEASE_DEFAULT_CHANNEL;
export const BRIDGE_RELEASE_EXPERIMENTAL_CHANNEL = AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL;
export const BRIDGE_RELEASE_PLATFORM = AMBIENT_RELEASE_PLATFORM;
export const BRIDGE_RELEASE_ARCH = AMBIENT_RELEASE_ARCH;
export const BRIDGE_WINDOWS_RELEASE_PLATFORM = AMBIENT_WINDOWS_RELEASE_PLATFORM;
export const BRIDGE_WINDOWS_RELEASE_ARCH = AMBIENT_WINDOWS_RELEASE_ARCH;
export const BRIDGE_UPDATE_DEFAULT_BASE_URL = AMBIENT_UPDATE_DEFAULT_BASE_URL;

export function bridgeUpdateBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  // Mirrors the app updater: the update feed lives on the release CDN, never the
  // API server. Its own dedicated env (AMBIENT_BRIDGE_UPDATE_BASE_URL) can point
  // it elsewhere for testing; it is not coupled to the inference server URL.
  return env.AMBIENT_BRIDGE_UPDATE_BASE_URL ?? BRIDGE_UPDATE_DEFAULT_BASE_URL;
}

export function bridgeUpdateFeedUrl(input: {
  readonly baseUrl: string;
  readonly channel?: string;
  readonly arch?: string;
  readonly platform?: NodeJS.Platform;
}): string {
  return productUpdateFeedUrl({ ...input, productSlug: BRIDGE_RELEASE_PRODUCT_SLUG });
}

export function bridgeVersionedUpdateFeedUrl(input: {
  readonly baseUrl: string;
  readonly version: string;
  readonly channel?: string;
  readonly arch?: string;
  readonly platform?: NodeJS.Platform;
}): string {
  return productUpdateFeedUrl({ ...input, productSlug: BRIDGE_RELEASE_PRODUCT_SLUG });
}

export function bridgeReleaseListUrl(input: {
  readonly baseUrl: string;
  readonly channel?: string;
  readonly arch?: string;
  readonly platform?: NodeJS.Platform;
}): string {
  return productReleaseListUrl({ ...input, productSlug: BRIDGE_RELEASE_PRODUCT_SLUG });
}

export function bridgeUpdaterUnavailableReason(input: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly localQaBuild?: boolean;
}): string | null {
  return updaterUnavailableReason(input);
}

export function parseBridgeExperimentalBuildsResponse(input: {
  readonly channel: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
  readonly releasesUrl: string;
  readonly body: unknown;
}): AmbientReleaseBuildsSnapshot {
  return parseReleaseListResponse({ ...input, productSlug: BRIDGE_RELEASE_PRODUCT_SLUG });
}
