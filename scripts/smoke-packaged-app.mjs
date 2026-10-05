import { extractFile, listPackage } from "@electron/asar";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bridgePackagedDependencyPolicy,
} from "./package-dependency-policy.mjs";
import {
  resolveBuildBakeMarker,
  resolveBuildMultiplayerUrl,
  resolveBuildServerUrl,
} from "./generate-build-config.mjs";

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
const declaredDependencies = Object.keys(appPackage.dependencies ?? {}).sort();
const expectedRuntimeRoots = [...bridgePackagedDependencyPolicy.runtimeDependencyRoots].sort();
if (JSON.stringify(declaredDependencies) !== JSON.stringify(expectedRuntimeRoots)) {
  failures.push(
    `Bridge packaged dependencies must equal the external runtime roots (expected ${expectedRuntimeRoots.join(", ")}; found ${declaredDependencies.join(", ")})`,
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

  for (const childDependency of Object.keys(packageJson.optionalDependencies ?? {})) {
    if (!presentPackages.has(childDependency)) continue;
    queue.push({ dependency: childDependency, parent: packageName, peer: false, traverse: true });
  }

  for (const childDependency of Object.keys(packageJson.peerDependencies ?? {})) {
    if (packageJson.peerDependenciesMeta?.[childDependency]?.optional === true) continue;
    queue.push({ dependency: childDependency, parent: packageName, peer: true, traverse: true });
  }
}

const unexpectedPackages = [...presentPackages.keys()]
  .filter((dependency) => !reachablePackages.has(dependency))
  .sort();
if (unexpectedPackages.length > 0) {
  failures.push(`Bridge app.asar contains packages outside the runtime graph: ${unexpectedPackages.join(", ")}`);
}

const archiveBytes = statSync(archive).size;
if (archiveBytes > bridgePackagedDependencyPolicy.maxAsarBytes) {
  failures.push(
    `Bridge app.asar is ${formatMiB(archiveBytes)}, above the ${formatMiB(bridgePackagedDependencyPolicy.maxAsarBytes)} budget`,
  );
}

const packagedSourceMaps = files.filter((file) => file.endsWith(".map"));
if (packagedSourceMaps.length > 0) {
  failures.push(`Bridge app.asar contains ${packagedSourceMaps.length} source maps that should be upload-only`);
}

verifyPackagedServerOrigin();
verifyPackagedBridgeUi();
verifyPublicLicenseNotices();
verifyBundledLicenseNotices();
verifyPackagedSharedRuntimeExports();

if (failures.length > 0) {
  console.error("[bridge:smoke] packaged app dependency verification failed:");
  for (const failure of failures.sort()) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `[bridge:smoke] packaged app dependency verification passed (${formatMiB(archiveBytes)}, ${presentPackages.size} runtime packages)`,
);

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function verifyBundledLicenseNotices() {
  for (const noticePath of [
    "/dist/renderer/THIRD_PARTY_LICENSES.md",
    "/dist/electron/MAIN_THIRD_PARTY_LICENSES.md",
    "/dist/electron/PRELOAD_THIRD_PARTY_LICENSES.md",
  ]) {
    if (!packageHasPath(noticePath)) {
      failures.push(`Bridge package is missing bundled dependency notices: ${noticePath}`);
    }
  }
  for (const font of ["inter", "stix-two-text", "jetbrains-mono"]) {
    const noticePath = path.join(path.dirname(archive), "licenses", `${font}.txt`);
    if (!existsSync(noticePath) || !readFileSync(noticePath, "utf8").includes("SIL OPEN FONT LICENSE")) {
      failures.push(`Bridge package is missing the complete font license: ${font}`);
    }
  }
}

function readPackageJson(asarPath) {
  return JSON.parse(readAsarText(asarPath));
}

function readAsarText(asarPath) {
  const normalizedPath = asarPath.startsWith("/") ? asarPath.slice(1) : asarPath;
  return extractFile(archive, normalizedPath).toString("utf8");
}

function verifyPackagedServerOrigin() {
  // Bake still picks one default realm. Dev Settings retarget embeds the other
  // allowlisted origin in the same bundle, so "found staging" is not a failed
  // Nightly bake. The generate-time marker is the default.
  const expectedOrigin = resolveBuildServerUrl(process.env);
  const expectedMultiplayerOrigin = resolveBuildMultiplayerUrl(process.env);
  const expectedBakeMarker = resolveBuildBakeMarker(process.env);

  const mainPath = "/dist/electron/main.js";
  if (!packageHasPath(mainPath)) {
    failures.push(`Bridge packaged runtime file is missing from app.asar: ${mainPath}`);
    return;
  }
  const source = readAsarText(mainPath);
  if (!source.includes(expectedBakeMarker)) {
    failures.push(
      `Bridge packaged main bundle is missing bake marker ${expectedBakeMarker} (expected default ${expectedOrigin}).`,
    );
  }
  if (!source.includes(expectedOrigin)) {
    failures.push(
      `Bridge packaged main bundle does not bake the expected server origin for this channel (${expectedOrigin}).`,
    );
  }
  if (!source.includes(expectedMultiplayerOrigin)) {
    failures.push(
      `Bridge packaged main bundle does not bake the expected Multiplayer ingest origin for this channel (${expectedMultiplayerOrigin}).`,
    );
  }
}

function verifyPackagedBridgeUi() {
  for (const runtimePath of [
    "/dist/electron/main.js",
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

function verifyPackagedSharedRuntimeExports() {
  // @ambient/shared Electron-main subpaths are Vite-bundled into
  // dist/electron/main.js. Confirm a representative shared symbol landed in the
  // main bundle rather than requiring a separate JS file under node_modules.
  const mainPath = "/dist/electron/main.js";
  if (!packageHasPath(mainPath)) return;
  const source = readAsarText(mainPath);
  for (const marker of ["INSUFFICIENT_CREDIT", "productUpdateFeedUrl", "/updates/apps/"]) {
    if (!source.includes(marker)) {
      failures.push(`Bridge packaged main bundle is missing bundled shared runtime marker: ${marker}`);
    }
  }
}

function verifyPublicLicenseNotices() {
  for (const noticePath of ["/LICENSE", "/THIRD_PARTY_NOTICES.md"]) {
    if (!packageHasPath(noticePath)) {
      failures.push(`Bridge public package is missing required notice: ${noticePath}`);
    }
  }
}

function packageHasPath(asarPath) {
  const normalizedPath = asarPath.startsWith("/") ? asarPath : `/${asarPath}`;
  return files.includes(normalizedPath) || files.includes(normalizedPath.slice(1));
}
