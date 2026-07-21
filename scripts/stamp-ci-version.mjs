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
const prNumber = args["pr-number"] ?? process.env.GITHUB_PR_NUMBER;
const runId = args["run-id"] ?? process.env.GITHUB_RUN_ID;
const runAttempt = args["run-attempt"] ?? process.env.GITHUB_RUN_ATTEMPT;
const prerelease = ciPrerelease({ preid, prNumber, runAttempt, runId, runNumber });

const nextVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}-${prerelease}`;

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

function ciPrerelease({ preid, prNumber, runAttempt, runId, runNumber }) {
  // PR-scoped iff a --pr-number is supplied. runId is not a selector here: it
  // falls back to the always-present GITHUB_RUN_ID, so gating on it would force
  // every channel-scoped release (which passes no --pr-number) down this path
  // and fail. Channel-scoped releases fall through to the run-number form below.
  if (prNumber) {
    if (!/^[1-9]\d*$/.test(prNumber)) {
      throw new Error("A positive --pr-number value is required when stamping a PR-scoped CI version.");
    }
    if (!runId || !/^[1-9]\d*$/.test(runId)) {
      throw new Error("A positive --run-id value or GITHUB_RUN_ID is required when stamping a PR-scoped CI version.");
    }

    const parts = [preid, `pr${prNumber}`, runId];
    if (runAttempt && runAttempt !== "1") {
      if (!/^[1-9]\d*$/.test(runAttempt)) {
        throw new Error("--run-attempt or GITHUB_RUN_ATTEMPT must be a positive integer when provided.");
      }
      parts.push(`attempt${runAttempt}`);
    }
    return parts.join(".");
  }

  if (!runNumber || !/^[1-9]\d*$/.test(runNumber)) {
    throw new Error("A positive --run-number value or GITHUB_RUN_NUMBER is required.");
  }
  return `${preid}.${runNumber}`;
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
