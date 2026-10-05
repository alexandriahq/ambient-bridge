import { describe, expect, it } from "vitest";
import {
  BRIDGE_UPDATE_DEFAULT_BASE_URL,
  bridgeChangelogUrl,
  bridgeUpdateBaseUrlFromEnv,
  bridgeUpdateFeedUrl,
  bridgeUpdaterUnavailableReason,
} from "../electron/update-feed.js";

describe("Bridge update feed", () => {
  it("uses the production update server by default while preserving overrides", () => {
    expect(BRIDGE_UPDATE_DEFAULT_BASE_URL).toBe("https://api.alexandria.so");
    expect(bridgeUpdateBaseUrlFromEnv({})).toBe("https://api.alexandria.so");
    expect(bridgeUpdateFeedUrl({ baseUrl: bridgeUpdateBaseUrlFromEnv({}) })).toBe(
      "https://api.alexandria.so/updates/apps/ambient-bridge/alpha/darwin/arm64/",
    );
    // The update feed is not coupled to the API server URL; AMBIENT_SERVER_URL is ignored.
    expect(bridgeUpdateBaseUrlFromEnv({ AMBIENT_SERVER_URL: "http://localhost:3000/" })).toBe(
      "https://api.alexandria.so",
    );
    // Only its own dedicated env overrides the update base.
    expect(bridgeUpdateFeedUrl({
      baseUrl: bridgeUpdateBaseUrlFromEnv({
        AMBIENT_BRIDGE_UPDATE_BASE_URL: "https://updates.example.test/",
      }),
    })).toBe("https://updates.example.test/updates/apps/ambient-bridge/alpha/darwin/arm64/");
  });

  it("builds the product-scoped ambient-bridge update URL", () => {
    expect(bridgeUpdateFeedUrl({
      arch: "arm64",
      baseUrl: "https://server.example.test/root?ignored=true#hash",
      channel: "alpha",
      platform: "darwin",
    })).toBe("https://server.example.test/updates/apps/ambient-bridge/alpha/darwin/arm64/");
    expect(bridgeUpdateFeedUrl({
      arch: "x64",
      baseUrl: "https://server.example.test/root?ignored=true#hash",
      channel: "alpha",
      platform: "win32",
    })).toBe("https://server.example.test/updates/apps/ambient-bridge/alpha/win32/x64/");
    expect(bridgeChangelogUrl({
      arch: "x64",
      baseUrl: "https://server.example.test/root?ignored=true#hash",
      channel: "alpha",
      platform: "win32",
    })).toBe("https://server.example.test/changelog/apps/ambient-bridge/alpha/win32/x64");
  });

  it.each([
    ["darwin", "arm64"],
    ["win32", "x64"],
  ] as const)("keeps optional version segments encoded for %s %s", (platform, arch) => {
    for (const [version, suffix] of [
      ["", ""],
      ["1.0.4", "1.0.4/"],
      ["1.0.4+qa /?#", "1.0.4%2Bqa%20%2F%3F%23/"],
    ]) {
      expect(bridgeUpdateFeedUrl({
        baseUrl: "https://updates.example.test/base?ignored=yes#hash",
        platform,
        arch,
        channel: "nightly",
        version,
      })).toBe(`https://updates.example.test/updates/apps/ambient-bridge/nightly/${platform}/${arch}/${suffix}`);
    }
  });

  it("keeps dev and unsupported Bridge builds out of auto-update", () => {
    expect(bridgeUpdaterUnavailableReason({ arch: "arm64", isPackaged: false, platform: "darwin" }))
      .toBe("Updates are unavailable in development builds.");
    expect(bridgeUpdaterUnavailableReason({ arch: "x64", isPackaged: true, localQaBuild: true, platform: "win32" }))
      .toBe("Updates are disabled for local QA builds.");
    expect(bridgeUpdaterUnavailableReason({ arch: "arm64", isPackaged: true, localQaBuild: true, platform: "darwin" }))
      .toBe("Updates are disabled for local QA builds.");
    expect(bridgeUpdaterUnavailableReason({ arch: "arm64", isPackaged: true, platform: "linux" }))
      .toBe("Ambient App installs Bridge updates. Bridge does not self-update.");
    expect(bridgeUpdaterUnavailableReason({ arch: "x64", isPackaged: true, platform: "linux" }))
      .toBe("Ambient App installs Bridge updates. Bridge does not self-update.");
    expect(bridgeUpdaterUnavailableReason({ arch: "x64", isPackaged: true, platform: "darwin" }))
      .toBe("Updates are only configured for macOS arm64 builds.");
    expect(bridgeUpdaterUnavailableReason({ arch: "arm64", isPackaged: true, platform: "win32" }))
      .toBe("Updates are only configured for Windows x64 builds.");
    expect(bridgeUpdaterUnavailableReason({
      arch: "x64",
      channel: "experimental",
      isPackaged: true,
      platform: "win32",
    })).toBe("Automatic updates are disabled for Experimental builds. Install a specific Experimental build from Settings → Dev.");
    expect(bridgeUpdaterUnavailableReason({
      arch: "x64",
      channel: "experimental",
      isPackaged: true,
      platform: "win32",
      version: "1.0.0-experimental.pr431.30379606652",
    })).toBe("Automatic updates are disabled for Experimental builds. Install a specific Experimental build from Settings → Dev.");
    expect(bridgeUpdaterUnavailableReason({ arch: "arm64", isPackaged: true, platform: "darwin" })).toBeNull();
    expect(bridgeUpdaterUnavailableReason({ arch: "x64", isPackaged: true, platform: "win32" })).toBeNull();
  });
});
