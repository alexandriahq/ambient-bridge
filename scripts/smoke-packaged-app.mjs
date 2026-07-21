import { extractFile, listPackage } from "@electron/asar";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bridgePackagedDependencyPolicy,
  classifyBridgePackageDependencies,
} from "./package-dependency-policy.mjs";
import { resolveBuildServerUrl } from "./generate-build-config.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.resolve(scriptDir, "..");
const archive = process.env.BRIDGE_PACKAGED_ASAR_PATH
  ? path.resolve(process.env.BRIDGE_PACKAGED_ASAR_PATH)
  : path.join(
    bridgeDir,
    "dist-packaged",
    "mac-arm64",
    "Ambient Bridge.app",
    "Contents",
    "Resources",
    "app.asar",
  );
const packageJsonPathPattern = /(?:^|\/)node_modules\/((?:@[^/]+\/[^/]+)|[^/]+)\/package\.json$/;
const productionServerOrigin = "https://api.alexandria.so";
const stagingServerOrigin = "https://ambientserver-staging.up.railway.app";

if (!existsSync(archive)) {
  console.error(`[bridge:smoke] missing packaged app archive: ${archive}`);
  process.exit(1);
}

const files = listPackage(archive);
const packagePaths = files.filter((file) => packageJsonPathPattern.test(file));
const presentPackages = new Map();
const failures = [];

for (const packagePath of packagePaths) {
  const packageJson = readPackageJson(packagePath);
  if (typeof packageJson.name === "string") {
    presentPackages.set(packageJson.name, packagePath);
  }
}

const appPackage = readPackageJson("/package.json");
const declaredDependencies = Object.keys(appPackage.dependencies ?? {});
const dependencyClassification = classifyBridgePackageDependencies(declaredDependencies);
if (dependencyClassification.unclassified.length > 0) {
  failures.push(
    `Bridge package dependencies need an explicit packaged dependency policy: ${dependencyClassification.unclassified.join(", ")}`,
  );
}
if (dependencyClassification.missingFromPackageJson.length > 0) {
  failures.push(
    `Bridge packaged dependency policy references dependencies missing from package.json: ${dependencyClassification.missingFromPackageJson.join(", ")}`,
  );
}

const reachablePackages = new Set();
const nonTraversedPackageRoots = new Set(bridgePackagedDependencyPolicy.nonTraversedPackageRoots);
const queue = bridgePackagedDependencyPolicy.runtimeDependencyRoots.map((dependency) => ({
  dependency,
  parent: "Bridge runtime dependency policy",
  peer: false,
  traverse: !nonTraversedPackageRoots.has(dependency),
}));

while (queue.length > 0) {
  const { dependency, parent, peer, traverse } = queue.shift();
  const packagePath = presentPackages.get(dependency);
  if (!packagePath) {
    const relation = peer ? "peer dependency" : "dependency";
    failures.push(`${parent} requires ${relation} ${dependency}, but it is missing from packaged app.asar`);
    continue;
  }
  if (reachablePackages.has(dependency)) continue;

  reachablePackages.add(dependency);
  if (!traverse) continue;

  const packageJson = readPackageJson(packagePath);
  const packageName = typeof packageJson.name === "string" ? packageJson.name : dependency;
  for (const childDependency of Object.keys(packageJson.dependencies ?? {})) {
    queue.push({ dependency: childDependency, parent: packageName, peer: false, traverse: true });
  }

  for (const childDependency of Object.keys(packageJson.peerDependencies ?? {})) {
    if (packageJson.peerDependenciesMeta?.[childDependency]?.optional === true) continue;
    queue.push({ dependency: childDependency, parent: packageName, peer: true, traverse: true });
  }
}

verifyPackagedServerOrigin();
verifyPackagedBridgeUi();

if (failures.length > 0) {
  console.error("[bridge:smoke] packaged app dependency verification failed:");
  for (const failure of failures.sort()) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `[bridge:smoke] packaged app dependency verification passed (${presentPackages.size} packages, ${reachablePackages.size} runtime dependency roots/transitives)`,
);

function readPackageJson(asarPath) {
  return JSON.parse(readAsarText(asarPath));
}

function readAsarText(asarPath) {
  const normalizedPath = asarPath.startsWith("/") ? asarPath.slice(1) : asarPath;
  return extractFile(archive, normalizedPath).toString("utf8");
}

function verifyPackagedServerOrigin() {
  // The default server origin is baked at build time from the release channel
  // into build-config.js (see generate-build-config.mjs). Expect exactly the
  // origin that channel resolves to, and guard against the other one leaking in.
  const expectedOrigin = resolveBuildServerUrl(process.env);
  const forbiddenOrigin =
    expectedOrigin === productionServerOrigin ? stagingServerOrigin : productionServerOrigin;

  for (const runtimePath of ["/dist/electron/auth/server-client.js", "/dist/electron/main.js"]) {
    if (!packageHasPath(runtimePath)) {
      failures.push(`Bridge packaged runtime file is missing from app.asar: ${runtimePath}`);
    }
  }

  const buildConfigPath = "/dist/electron/generated/build-config.js";
  if (!packageHasPath(buildConfigPath)) {
    failures.push(`Bridge packaged build-config is missing from app.asar: ${buildConfigPath}`);
    return;
  }
  const source = readAsarText(buildConfigPath);
  if (!source.includes(expectedOrigin)) {
    failures.push(
      `Bridge packaged build-config does not bake the expected server origin for this channel (${expectedOrigin}).`,
    );
  }
  if (source.includes(forbiddenOrigin)) {
    failures.push(
      `Bridge packaged build-config bakes the wrong server origin for this channel (found ${forbiddenOrigin}, expected ${expectedOrigin}).`,
    );
  }
}

function verifyPackagedBridgeUi() {
  for (const runtimePath of [
    "/dist/electron/bridge-ui-ipc.js",
    "/dist/electron/preload.cjs",
    "/dist/renderer/index.html",
  ]) {
    if (!packageHasPath(runtimePath)) {
      failures.push(`Bridge packaged UI runtime file is missing from app.asar: ${runtimePath}`);
    }
  }

  const preloadPath = "/dist/electron/preload.cjs";
  if (!packageHasPath(preloadPath)) return;
  const preloadSource = readAsarText(preloadPath);
  for (const channel of ["bridge:get-wire-capture", "bridge:copy-wire-payload"]) {
    if (!preloadSource.includes(channel)) {
      failures.push(`Bridge packaged preload is missing renderer IPC channel ${channel}.`);
    }
  }
}

function packageHasPath(asarPath) {
  const normalizedPath = asarPath.startsWith("/") ? asarPath : `/${asarPath}`;
  return files.includes(normalizedPath) || files.includes(normalizedPath.slice(1));
}
