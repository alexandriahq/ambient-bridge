import { describe, expect, it } from "vitest";
import { resolveBridgeDesktopIdentity } from "./desktop-identity.js";

describe("resolveBridgeDesktopIdentity", () => {
  it("uses packaged Local metadata when generated identity was raced to standard", () => {
    expect(resolveBridgeDesktopIdentity({
      buildAppId: "com.alexandria.ambient.bridge",
      buildAppName: "Ambient Bridge",
      packaged: true,
      packagedAppName: "Ambient Bridge Local",
    })).toEqual({
      appId: "com.alexandria.ambient.bridge.local",
      appName: "Ambient Bridge Local",
    });
  });

  it("uses packaged standard metadata when generated identity was raced to Local", () => {
    expect(resolveBridgeDesktopIdentity({
      buildAppId: "com.alexandria.ambient.bridge.local",
      buildAppName: "Ambient Bridge Local",
      packaged: true,
      packagedAppName: "Ambient Bridge",
    })).toEqual({
      appId: "com.alexandria.ambient.bridge",
      appName: "Ambient Bridge",
    });
  });

  it("keeps generated identity for unpackaged development", () => {
    expect(resolveBridgeDesktopIdentity({
      buildAppId: "com.alexandria.ambient.bridge.local",
      buildAppName: "Ambient Bridge Local",
      packaged: false,
      packagedAppName: "@ambient/bridge",
    })).toEqual({
      appId: "com.alexandria.ambient.bridge.local",
      appName: "Ambient Bridge Local",
    });
  });
});
