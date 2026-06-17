import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const packageJsonPath = args["package-json"]
  ? path.resolve(args["package-json"])
  : fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const currentVersion = String(packageJson.version ?? "");
const parsed = parseVersion(currentVersion);
const logPrefix = args["log-prefix"] ?? "release";
const preid = args.preid ?? parsed.preid ?? "alpha";
const runNumber = args["run-number"] ?? process.env.GITHUB_RUN_NUMBER;

if (!runNumber || !/^[1-9]\d*$/.test(runNumber)) {
  throw new Error("A positive --run-number value or GITHUB_RUN_NUMBER is required.");
}

const nextVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}-${preid}.${runNumber}`;

if (!args["dry-run"]) {
  packageJson.version = nextVersion;
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  if (process.env.GITHUB_ENV) {
    await appendFile(process.env.GITHUB_ENV, `AMBIENT_CI_VERSION=${nextVersion}\n`);
  }
}

console.log(`[${logPrefix}] stamped CI version ${currentVersion} -> ${nextVersion}`);

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    if (!value.startsWith("--")) continue;
    const [key, rawValue = "true"] = value.slice(2).split(/=(.*)/s, 2);
    parsed[key] = rawValue;
  }
  return parsed;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) {
    throw new Error(`Package version ${JSON.stringify(value)} is not valid semver.`);
  }

  const [, major, minor, patch, prerelease] = match;
  const firstPrereleasePart = prerelease?.split(".").find((part) => !/^\d+$/.test(part));
  return {
    major,
    minor,
    patch,
    preid: firstPrereleasePart,
  };
}
