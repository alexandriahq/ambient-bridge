import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("Windows package branding", () => {
  test("local and release installers embed the canonical Bridge icon", () => {
    const bridgeRoot = path.resolve(import.meta.dirname, "..");
    const manifest = JSON.parse(readFileSync(path.join(bridgeRoot, "package.json"), "utf8"));
    const base = readFileSync(path.join(bridgeRoot, "electron-builder.yml"), "utf8");
    const local = readFileSync(path.join(bridgeRoot, "electron-builder.local.yml"), "utf8");
    const afterPack = readFileSync(
      path.join(bridgeRoot, "scripts", "afterpack-tahoe-icon.cjs"),
      "utf8",
    );

    expect(base).toMatch(/appId:\s*com\.alexandria\.ambient\.bridge/);
    expect(base).toMatch(/win:[\s\S]*?icon:\s*resources\/bridge-icon\.ico/);
    expect(base).toMatch(/win:[\s\S]*?signAndEditExecutable:\s*true/);
    expect(base).toMatch(/installerIcon:\s*resources\/bridge-icon\.ico/);
    expect(base).toMatch(/uninstallerIcon:\s*resources\/bridge-icon\.ico/);
    expect(local).toMatch(/extends:\s*electron-builder\.yml/);
    expect(local).toMatch(/win:[\s\S]*?signAndEditExecutable:\s*false/);
    expect(manifest.devDependencies.rcedit).toBe("5.0.2");
    expect(afterPack).toContain('electronPlatformName === "win32"');
    expect(afterPack).toContain('{ rcedit } = require("rcedit")');
    expect(afterPack).toContain('resources/bridge-icon.ico');
    expect(afterPack).toContain('ProductName: appName');
  });
});
