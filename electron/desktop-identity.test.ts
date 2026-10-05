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

  it("keeps Local identity for unpackaged Local development builds", () => {
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

  it("maps unpackaged non-Local runs to the .dev identity so electron.exe cannot claim production AUMID", () => {
    expect(resolveBridgeDesktopIdentity({
      buildAppId: "com.alexandria.ambient.bridge",
      buildAppName: "Ambient Bridge",
      packaged: false,
      packagedAppName: "@ambient/bridge",
    })).toEqual({
      appId: "com.alexandria.ambient.bridge.dev",
      appName: "Ambient Bridge Dev",
    });
  });

  it("keeps an already-baked .dev identity for unpackaged source runs", () => {
    expect(resolveBridgeDesktopIdentity({
      buildAppId: "com.alexandria.ambient.bridge.dev",
      buildAppName: "Ambient Bridge Dev",
      packaged: false,
      packagedAppName: "@ambient/bridge",
    })).toEqual({
      appId: "com.alexandria.ambient.bridge.dev",
      appName: "Ambient Bridge Dev",
    });
  });
});
