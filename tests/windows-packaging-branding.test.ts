import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

describe("Windows package branding", () => {
  test("local and release installers embed the canonical Bridge icon", () => {
    const bridgeRoot = path.resolve(import.meta.dirname, "..");
    const base = parse(readFileSync(path.join(bridgeRoot, "electron-builder.yml"), "utf8"));
    const local = parse(readFileSync(path.join(bridgeRoot, "electron-builder.local.yml"), "utf8"));

    expect(base.appId).toBe("com.alexandria.ambient.bridge");
    expect(base.mac.extendInfo.LSUIElement).toBe(true);
    expect(base.win).toMatchObject({ icon: "resources/bridge-icon.ico", signAndEditExecutable: true });
    expect(base.nsis).toMatchObject({ installerIcon: "resources/bridge-icon.ico", uninstallerIcon: "resources/bridge-icon.ico" });
    expect(local).toMatchObject({
      extends: "electron-builder.yml",
      appId: "com.alexandria.ambient.bridge.local",
      productName: "Ambient Bridge Local",
      extraMetadata: { name: "ambient-bridge-local" },
      win: { signAndEditExecutable: false },
    });
    expect(local.nsis.artifactName).toBe("${productName} Setup ${version}.${ext}");
  });
});
