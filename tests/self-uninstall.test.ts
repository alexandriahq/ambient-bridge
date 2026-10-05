import { describe, expect, test } from "vitest";
import { bridgeAppBundlePath, bridgeUninstallAvailability, uninstallPackagedBridge } from "../electron/self-uninstall.js";

describe("Bridge self uninstall", () => {
  test("finds the containing macOS app bundle", () => {
    expect(bridgeAppBundlePath({
      execPath: "/Applications/Ambient Bridge.app/Contents/MacOS/Ambient Bridge",
      packaged: true,
      platform: "darwin",
    })).toBe("/Applications/Ambient Bridge.app");
  });

  test("is unavailable for development and unsupported builds", () => {
    expect(bridgeUninstallAvailability({ execPath: "/tmp/Electron", packaged: false, platform: "darwin" })).toEqual({
      available: false,
      reason: "Uninstall is available in packaged Bridge builds.",
      method: null,
    });
    expect(bridgeUninstallAvailability({
      execPath: "/usr/local/bin/ambient-bridge",
      packaged: true,
      platform: "freebsd",
    })).toEqual({
      available: false,
      reason: "Use your system app settings to uninstall Ambient Bridge.",
      method: null,
    });
  });

  test("uses PolicyKit to uninstall packaged Linux Bridge", () => {
    expect(bridgeUninstallAvailability({
      execPath: "/opt/Ambient Bridge/ambient-bridge",
      packaged: true,
      platform: "linux",
    })).toEqual({
      available: true,
      reason: null,
      method: "pkexec",
    });
  });

  test("removes the Linux package instead of trashing a bundle", async () => {
    const removed: string[] = [];
    await uninstallPackagedBridge({
      execPath: "/opt/Ambient Bridge/ambient-bridge",
      packaged: true,
      platform: "linux",
      trashItem: async () => { throw new Error("must not trash"); },
      removeDebOwningPath: async (target) => { removed.push(target); },
    });
    expect(removed).toEqual(["/opt/Ambient Bridge/ambient-bridge"]);
  });

  test("uses silent NSIS uninstall for packaged Windows Bridge", () => {
    expect(bridgeUninstallAvailability({
      execPath: "C:\\Users\\qa\\AppData\\Local\\Programs\\Ambient Bridge\\Ambient Bridge.exe",
      packaged: true,
      platform: "win32",
    })).toEqual({
      available: true,
      reason: null,
      method: "nsis",
    });
  });

  test("starts the Windows uninstaller instead of trashing a bundle", async () => {
    const started: Array<{ path: string; product: string }> = [];
    await uninstallPackagedBridge({
      execPath: "C:\\Users\\qa\\AppData\\Local\\Programs\\Ambient Bridge\\Ambient Bridge.exe",
      packaged: true,
      platform: "win32",
      productName: "Ambient Bridge",
      trashItem: async () => { throw new Error("must not trash"); },
      runNsisUninstaller: async (uninstallerPath, productName) => {
        started.push({ path: uninstallerPath, product: productName });
      },
    });
    expect(started).toEqual([{
      path: "C:\\Users\\qa\\AppData\\Local\\Programs\\Ambient Bridge\\Uninstall Ambient Bridge.exe",
      product: "Ambient Bridge",
    }]);
  });
  test("refuses to resolve an unrelated containing app bundle", () => {
    expect(bridgeAppBundlePath({
      execPath: "/Applications/Other Utility.app/Contents/MacOS/Ambient Bridge",
      packaged: true,
      platform: "darwin",
    })).toBeNull();
  });
});

test("macOS uninstall uses Finder after Trash fails and propagates cancellation", async () => {
  const targets: string[] = [];
  const options = {
    execPath: "/Applications/Ambient Bridge.app/Contents/MacOS/Ambient Bridge",
    packaged: true,
    platform: "darwin" as const,
    trashItem: async () => { throw new Error("Trash denied"); },
    trashWithFinder: async (target: string) => { targets.push(target); },
  };
  await uninstallPackagedBridge(options);
  expect(targets).toEqual(["/Applications/Ambient Bridge.app"]);
  await expect(uninstallPackagedBridge({ ...options, trashWithFinder: async () => {
    throw new Error("Uninstall was cancelled");
  } })).rejects.toThrow("cancelled");
});
