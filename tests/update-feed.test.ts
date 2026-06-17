import { describe, expect, it } from "vitest";
import { bridgeUpdateFeedUrl, bridgeUpdaterUnavailableReason } from "../electron/update-feed.js";

describe("Bridge update feed", () => {
  it("builds the product-scoped ambient-bridge update URL", () => {
    expect(bridgeUpdateFeedUrl({
      arch: "arm64",
      baseUrl: "https://server.example.test/root?ignored=true#hash",
      channel: "alpha",
    })).toBe("https://server.example.test/updates/apps/ambient-bridge/alpha/darwin/arm64/");
  });

  it("keeps dev and unsupported Bridge builds out of auto-update", () => {
    expect(bridgeUpdaterUnavailableReason({ arch: "arm64", isPackaged: false, platform: "darwin" }))
      .toBe("Updates are unavailable in development builds.");
    expect(bridgeUpdaterUnavailableReason({ arch: "arm64", isPackaged: true, platform: "linux" }))
      .toBe("Updates are only available for packaged macOS builds.");
    expect(bridgeUpdaterUnavailableReason({ arch: "x64", isPackaged: true, platform: "darwin" }))
      .toBe("Updates are only configured for macOS arm64 builds.");
    expect(bridgeUpdaterUnavailableReason({ arch: "arm64", isPackaged: true, platform: "darwin" })).toBeNull();
  });
});
