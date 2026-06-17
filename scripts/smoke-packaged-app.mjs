import { extractFile, listPackage } from "@electron/asar";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
for (const dependency of Object.keys(appPackage.dependencies ?? {})) {
  if (!presentPackages.has(dependency)) {
    failures.push(`Bridge dependency ${dependency} is missing from packaged app.asar`);
  }
}

for (const packagePath of packagePaths) {
  const packageJson = readPackageJson(packagePath);
  const packageName = typeof packageJson.name === "string" ? packageJson.name : packagePath;
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    if (presentPackages.has(dependency)) continue;

    failures.push(`${packageName} requires dependency ${dependency}, but it is missing from packaged app.asar`);
  }

  for (const dependency of Object.keys(packageJson.peerDependencies ?? {})) {
    if (packageJson.peerDependenciesMeta?.[dependency]?.optional === true) continue;
    if (presentPackages.has(dependency)) continue;

    failures.push(`${packageName} requires peer dependency ${dependency}, but it is missing from packaged app.asar`);
  }
}

if (failures.length > 0) {
  console.error("[bridge:smoke] packaged app dependency verification failed:");
  for (const failure of failures.sort()) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`[bridge:smoke] packaged app dependency verification passed (${presentPackages.size} packages)`);

function readPackageJson(asarPath) {
  const normalizedPath = asarPath.startsWith("/") ? asarPath.slice(1) : asarPath;
  return JSON.parse(extractFile(archive, normalizedPath).toString("utf8"));
}
