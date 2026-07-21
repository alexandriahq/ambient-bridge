import { describe, expect, it } from "vitest";
import {
  BRIDGE_UPDATE_DEFAULT_BASE_URL,
  bridgeReleaseListUrl,
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
    expect(bridgeReleaseListUrl({
      arch: "arm64",
      baseUrl: "https://server.example.test/root?ignored=true#hash",
      channel: "alpha",
      platform: "darwin",
    })).toBe("https://server.example.test/releases/apps/ambient-bridge/alpha/darwin/arm64");
  });

  it("keeps dev and unsupported Bridge builds out of auto-update", () => {
    expect(bridgeUpdaterUnavailableReason({ arch: "arm64", isPackaged: false, platform: "darwin" }))
      .toBe("Updates are unavailable in development builds.");
    expect(bridgeUpdaterUnavailableReason({ arch: "x64", isPackaged: true, localQaBuild: true, platform: "win32" }))
      .toBe("Updates are disabled for local QA builds.");
    expect(bridgeUpdaterUnavailableReason({ arch: "arm64", isPackaged: true, localQaBuild: true, platform: "darwin" }))
      .toBe("Updates are disabled for local QA builds.");
    expect(bridgeUpdaterUnavailableReason({ arch: "arm64", isPackaged: true, platform: "linux" }))
      .toBe("Updates are only available for packaged macOS arm64 and Windows x64 builds.");
    expect(bridgeUpdaterUnavailableReason({ arch: "x64", isPackaged: true, platform: "darwin" }))
      .toBe("Updates are only configured for macOS arm64 builds.");
    expect(bridgeUpdaterUnavailableReason({ arch: "arm64", isPackaged: true, platform: "win32" }))
      .toBe("Updates are only configured for Windows x64 builds.");
    expect(bridgeUpdaterUnavailableReason({ arch: "arm64", isPackaged: true, platform: "darwin" })).toBeNull();
    expect(bridgeUpdaterUnavailableReason({ arch: "x64", isPackaged: true, platform: "win32" })).toBeNull();
  });
});
