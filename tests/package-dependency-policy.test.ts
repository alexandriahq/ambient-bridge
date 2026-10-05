import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharedRoot = path.resolve(bridgeRoot, "shared");

describe("Bridge packaged dependency policy", () => {
  it("keeps only external Electron runtime roots in production dependencies", async () => {
    const packageJson = JSON.parse(await readFile(path.join(bridgeRoot, "package.json"), "utf8"));
    const { bridgePackagedDependencyPolicy } = await import("../scripts/package-dependency-policy.mjs");

    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual(
      [...bridgePackagedDependencyPolicy.runtimeDependencyRoots].sort(),
    );
    expect(Object.keys(packageJson.devDependencies ?? {})).toEqual(expect.arrayContaining([
      ...bridgePackagedDependencyPolicy.bundledDependencyRoots,
    ]));
  });

  it("keeps bundled source and UI dependencies out of the packaged runtime graph", async () => {
    const { bridgePackagedDependencyPolicy } = await import("../scripts/package-dependency-policy.mjs");

    expect(bridgePackagedDependencyPolicy.runtimeDependencyRoots).toEqual([
      "electron-updater",
      "tinfoil",
    ]);
    expect(bridgePackagedDependencyPolicy.bundledDependencyRoots).toEqual(expect.arrayContaining([
      "@ambient/shared",
      "effect",
      "@lucide/svelte",
      "svelte",
    ]));
    expect(bridgePackagedDependencyPolicy.maxAsarBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it("keeps upload-only maps and unused Chromium locales out of packaged builds", async () => {
    const builderConfig = parse(await readFile(path.join(bridgeRoot, "electron-builder.yml"), "utf8"));

    expect(builderConfig.files).toContain("!dist/**/*.map");
    expect(builderConfig.electronLanguages).toEqual(["en", "en-US", "en-GB", "en_GB"]);
  });

  it("publishes the shared usage contract as TypeScript source for Vite bundling", async () => {
    const packageJson = JSON.parse(await readFile(path.join(sharedRoot, "package.json"), "utf8"));
    const usageExport = packageJson.exports?.["./usage"];

    expect(usageExport).toEqual({
      default: "./src/usage.ts",
      types: "./src/usage.ts",
    });
    await expect(access(path.join(sharedRoot, usageExport.default))).resolves.toBeUndefined();

    const { default: mainConfig } = await import("../vite.main.config.js");
    expect(mainConfig.build?.rollupOptions?.external).not.toContain("@ambient/shared");
  });
});
