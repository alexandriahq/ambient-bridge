import { createPackage, extractFile, listPackage } from "@electron/asar";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Bridge packaged archive pruning", () => {
  it("keeps the automatically closed runtime graph and removes build-only files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ambient-bridge-prune-test-"));
    cleanupRoots.push(root);
    const source = path.join(root, "source");
    const archive = path.join(root, "app.asar");

    await writeJson(path.join(source, "package.json"), {
      dependencies: { "runtime-root": "1.0.0" },
      name: "fixture",
      version: "1.0.0",
    });
    await writeFileAt(path.join(source, "dist", "main.js"), "export const ok = true;\n");
    await writeFileAt(path.join(source, "dist", "main.js.map"), "{}\n");
    await writePackage(source, "runtime-root", {
      dependencies: { "runtime-child": "1.0.0" },
      optionalDependencies: { "runtime-optional": "1.0.0", "missing-optional": "1.0.0" },
      peerDependencies: { "runtime-peer": "1.0.0", "missing-optional-peer": "1.0.0" },
      peerDependenciesMeta: { "missing-optional-peer": { optional: true } },
    });
    await writePackage(source, "runtime-child");
    await writePackage(source, "runtime-optional");
    await writePackage(source, "runtime-peer");
    await writePackage(source, "build-only");
    await writeFileAt(
      path.join(source, "node_modules", "runtime-root", "index.js.map"),
      "{}\n",
    );
    await createPackage(source, archive);

    const { prunePackagedApp } = await import("../scripts/prune-packaged-app.mjs");
    const result = await prunePackagedApp({ archive, runtimeDependencyRoots: ["runtime-root"] });
    const files = normalizedPackagePaths(archive);

    expect(result.packages).toEqual([
      "runtime-child",
      "runtime-optional",
      "runtime-peer",
      "runtime-root",
    ]);
    expect(files).toContain("/dist/main.js");
    expect(files.some((file) => file.includes("build-only"))).toBe(false);
    expect(files.some((file) => file.endsWith(".map"))).toBe(false);
    expect(JSON.parse(extractFile(archive, "package.json").toString("utf8"))).toMatchObject({
      name: "fixture",
    });
  });

  it("rebuilds dependencies from the installed tree when Electron Builder omits a transitive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ambient-bridge-prune-source-test-"));
    cleanupRoots.push(root);
    const appSource = path.join(root, "app-source");
    const installedSource = path.join(root, "installed-source");
    const archive = path.join(root, "app.asar");

    await writeJson(path.join(appSource, "package.json"), {
      dependencies: { "runtime-root": "1.0.0" },
      name: "fixture",
      version: "1.0.0",
    });
    await writeFileAt(path.join(appSource, "dist", "main.js"), "export const ok = true;\n");
    await writePackage(installedSource, "runtime-root", {
      dependencies: { "omitted-transitive": "1.0.0" },
    });
    await writePackage(installedSource, "omitted-transitive");
    await createPackage(appSource, archive);

    const { prunePackagedApp } = await import("../scripts/prune-packaged-app.mjs");
    const result = await prunePackagedApp({
      archive,
      dependencyResolutionRoot: installedSource,
      dependencySourceRoot: installedSource,
      runtimeDependencyRoots: ["runtime-root"],
    });
    const files = normalizedPackagePaths(archive);

    expect(result.packages).toEqual(["omitted-transitive", "runtime-root"]);
    expect(files).toContain("/node_modules/runtime-root/package.json");
    expect(files).toContain("/node_modules/omitted-transitive/package.json");
  });
});

async function writePackage(root: string, name: string, manifest: Record<string, unknown> = {}) {
  const packageRoot = path.join(root, "node_modules", name);
  await writeJson(path.join(packageRoot, "package.json"), {
    name,
    version: "1.0.0",
    ...manifest,
  });
  await writeFileAt(path.join(packageRoot, "index.js"), `export default ${JSON.stringify(name)};\n`);
}

function normalizedPackagePaths(archive: string) {
  return listPackage(archive).map((file) => file.replaceAll("\\", "/"));
}

async function writeJson(file: string, value: unknown) {
  await writeFileAt(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAt(file: string, value: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}
