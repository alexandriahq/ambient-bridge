type BridgeMockPlatform = "darwin" | "win32" | "linux";

const PLATFORM_ALIASES: Record<string, BridgeMockPlatform> = {
  darwin: "darwin",
  mac: "darwin",
  macos: "darwin",
  osx: "darwin",
  win: "win32",
  win32: "win32",
  windows: "win32",
  linux: "linux",
};

export function resolveBridgeMockPlatform(): BridgeMockPlatform {
  const explicit = explicitMockPlatform();
  if (explicit) return explicit;

  if (typeof navigator !== "undefined") {
    const nav = navigator as Navigator & {
      readonly userAgentData?: { readonly platform?: string };
    };
    const detected = platformFromText(
      nav.userAgentData?.platform
      ?? nav.platform
      ?? nav.userAgent,
    );
    if (detected) return detected;
  }

  return "win32";
}

export function bridgeMockClientLabel(platform: BridgeMockPlatform): string {
  if (platform === "win32") return "Ambient (this Windows PC)";
  if (platform === "linux") return "Ambient (this Linux desktop)";
  return "Ambient (this Mac)";
}

function explicitMockPlatform(): BridgeMockPlatform | null {
  const queryPlatform = typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("mockPlatform")
      ?? new URLSearchParams(window.location.search).get("platform");
  return platformFromText(queryPlatform ?? import.meta.env.VITE_AMBIENT_MOCK_PLATFORM);
}

function platformFromText(value: string | null | undefined): BridgeMockPlatform | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (PLATFORM_ALIASES[normalized]) return PLATFORM_ALIASES[normalized];
  if (normalized.includes("win")) return "win32";
  if (normalized.includes("mac")) return "darwin";
  if (normalized.includes("linux")) return "linux";
  return null;
}
