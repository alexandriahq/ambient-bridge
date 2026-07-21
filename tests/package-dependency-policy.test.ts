import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Bridge packaged dependency policy", () => {
  it("classifies every declared package dependency", async () => {
    const packageJson = JSON.parse(await readFile(path.join(bridgeRoot, "package.json"), "utf8"));
    const { classifyBridgePackageDependencies } = await import("../scripts/package-dependency-policy.mjs");

    expect(classifyBridgePackageDependencies(Object.keys(packageJson.dependencies ?? {}))).toEqual({
      missingFromPackageJson: [],
      unclassified: [],
    });
  });

  it("keeps shared UI dependency traversal out of the Electron runtime check", async () => {
    const { bridgePackagedDependencyPolicy } = await import("../scripts/package-dependency-policy.mjs");

    expect(bridgePackagedDependencyPolicy.runtimeDependencyRoots).toContain("@ambient/shared");
    expect(bridgePackagedDependencyPolicy.nonTraversedPackageRoots).toContain("@ambient/shared");
    expect(bridgePackagedDependencyPolicy.rendererBundleRoots).toEqual(expect.arrayContaining([
      "@lucide/svelte",
      "svelte",
    ]));
  });
});
