import { describe, expect, it } from "vitest";
import {
  authCallbackUrlFromArgv,
  shouldUseLoopbackAuthCallback,
} from "../electron/auth-callback.js";

describe("shouldUseLoopbackAuthCallback", () => {
  it("uses loopback on packaged Windows and Linux", () => {
    expect(shouldUseLoopbackAuthCallback({ platform: "win32", isPackaged: true })).toBe(true);
    expect(shouldUseLoopbackAuthCallback({ platform: "linux", isPackaged: true })).toBe(true);
  });

  it("uses the custom scheme on packaged macOS", () => {
    expect(shouldUseLoopbackAuthCallback({ platform: "darwin", isPackaged: true })).toBe(false);
  });

  it("uses loopback when unpackaged", () => {
    expect(shouldUseLoopbackAuthCallback({ platform: "darwin", isPackaged: false })).toBe(true);
  });

  it("honors AMBIENT_BRIDGE_AUTH_CALLBACK_MODE", () => {
    expect(shouldUseLoopbackAuthCallback({
      platform: "linux",
      isPackaged: true,
      env: { AMBIENT_BRIDGE_AUTH_CALLBACK_MODE: "protocol" },
    })).toBe(false);
    expect(shouldUseLoopbackAuthCallback({
      platform: "darwin",
      isPackaged: true,
      env: { AMBIENT_BRIDGE_AUTH_CALLBACK_MODE: "loopback" },
    })).toBe(true);
  });
});

describe("authCallbackUrlFromArgv", () => {
  it("finds the ambient-bridge URL among argv", () => {
    expect(authCallbackUrlFromArgv([
      "/usr/bin/ambient-bridge-local",
      "ambient-bridge://auth/callback?ticket=t&client_state=s",
    ])).toBe("ambient-bridge://auth/callback?ticket=t&client_state=s");
    expect(authCallbackUrlFromArgv(["--ambient-bridge-show"])).toBeNull();
  });
});
