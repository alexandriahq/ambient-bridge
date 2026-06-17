export const BRIDGE_RELEASE_PRODUCT_SLUG = "ambient-bridge";
export const BRIDGE_RELEASE_DEFAULT_CHANNEL = "alpha";
export const BRIDGE_RELEASE_PLATFORM = "darwin";
export const BRIDGE_RELEASE_ARCH = "arm64";

export function bridgeUpdateFeedUrl(input: {
  readonly baseUrl: string;
  readonly channel?: string;
  readonly arch?: string;
}): string {
  const channel = input.channel ?? BRIDGE_RELEASE_DEFAULT_CHANNEL;
  const arch = input.arch ?? BRIDGE_RELEASE_ARCH;
  return new URL(
    `/updates/apps/${BRIDGE_RELEASE_PRODUCT_SLUG}/${channel}/${BRIDGE_RELEASE_PLATFORM}/${arch}/`,
    normalizedBaseUrl(input.baseUrl),
  ).toString();
}

export function bridgeUpdaterUnavailableReason(input: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}): string | null {
  if (!input.isPackaged) return "Updates are unavailable in development builds.";
  if (input.platform !== BRIDGE_RELEASE_PLATFORM) return "Updates are only available for packaged macOS builds.";
  if (input.arch !== BRIDGE_RELEASE_ARCH) return "Updates are only configured for macOS arm64 builds.";
  return null;
}

function normalizedBaseUrl(rawValue: string): string {
  const url = new URL(rawValue);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}
