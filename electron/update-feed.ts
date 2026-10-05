// Thin product binding over @ambient/shared/update-core: Ambient App and
// Ambient Bridge share feed/changelog URLs and updater availability; only
// the product slug differs.
import {
  AMBIENT_RELEASE_DEFAULT_CHANNEL,
  AMBIENT_UPDATE_DEFAULT_BASE_URL,
  productChangelogUrl,
  productUpdateFeedUrl,
  updaterUnavailableReason,
} from "@ambient/shared/update-core";

export const BRIDGE_RELEASE_PRODUCT_SLUG = "ambient-bridge";
export const BRIDGE_RELEASE_DEFAULT_CHANNEL = AMBIENT_RELEASE_DEFAULT_CHANNEL;
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
  readonly version?: string;
}): string {
  return productUpdateFeedUrl({ ...input, productSlug: BRIDGE_RELEASE_PRODUCT_SLUG });
}

export function bridgeChangelogUrl(input: {
  readonly baseUrl: string;
  readonly channel?: string;
  readonly arch?: string;
  readonly platform?: NodeJS.Platform;
}): string {
  return productChangelogUrl({ ...input, productSlug: BRIDGE_RELEASE_PRODUCT_SLUG });
}

export function bridgeUpdaterUnavailableReason(input: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly localQaBuild?: boolean;
  readonly channel?: string;
  readonly version?: string;
}): string | null {
  if (input.platform === "linux") {
    return "Ambient App installs Bridge updates. Bridge does not self-update.";
  }
  return updaterUnavailableReason(input);
}
