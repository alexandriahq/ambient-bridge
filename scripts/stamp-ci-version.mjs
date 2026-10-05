import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    if (!value.startsWith("--")) continue;
    const [key, rawValue = "true"] = value.slice(2).split(/=(.*)/s, 2);
    parsed[key] = rawValue;
  }
  return parsed;
}

export function parseVersion(value) {
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

export function ciPrerelease({ preid, prNumber, runAttempt, runId, runNumber }) {
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

/**
 * UTC calendar day for a Nightly stamp, same shape T3 Code uses:
 * `X.Y.Z-nightly.YYYYMMDD.<run>`.
 */
export function formatNightlyDate(value = new Date()) {
  const date = value instanceof Date ? value : parseNightlyDate(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid nightly date: ${JSON.stringify(value)}`);
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

export function parseNightlyDate(value) {
  const raw = String(value ?? "").trim();
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (compact) {
    return new Date(Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3])));
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid nightly date: ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function resolveStampChannel({ channel, preid, parsedPreid }) {
  const explicit = typeof channel === "string" ? channel.trim().toLowerCase() : "";
  if (explicit === "stable" || explicit === "nightly" || explicit === "alpha" || explicit === "experimental") {
    return explicit;
  }
  const fromPreid = typeof preid === "string" ? preid.trim().toLowerCase() : "";
  if (fromPreid === "stable" || fromPreid === "nightly" || fromPreid === "alpha" || fromPreid === "experimental") {
    return fromPreid;
  }
  const inherited = typeof parsedPreid === "string" ? parsedPreid.trim().toLowerCase() : "";
  if (inherited === "stable") return "stable";
  if (inherited === "nightly" || inherited === "alpha" || inherited === "experimental") return inherited;
  return "alpha";
}

export function stampCiVersion({
  currentVersion,
  channel,
  date,
  preid,
  prNumber,
  runAttempt,
  runId,
  runNumber,
}) {
  const parsed = parseVersion(currentVersion);
  const resolvedChannel = resolveStampChannel({
    channel,
    parsedPreid: parsed.preid,
    preid,
  });
  if (resolvedChannel === "stable") {
    return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  }
  if (resolvedChannel === "nightly") {
    if (!runNumber || !/^[1-9]\d*$/.test(String(runNumber))) {
      throw new Error("A positive --run-number value or GITHUB_RUN_NUMBER is required.");
    }
    const day = formatNightlyDate(String(date ?? "").trim() || new Date());
    return `${parsed.major}.${parsed.minor}.${parsed.patch}-nightly.${day}.${runNumber}`;
  }
  const resolvedPreid = preid ?? resolvedChannel;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}-${ciPrerelease({
    preid: resolvedPreid,
    prNumber,
    runAttempt,
    runId,
    runNumber,
  })}`;
}

export async function applyStampedVersion(options) {
  const packageJsonPath = options.packageJsonPath;
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const currentVersion = String(packageJson.version ?? "");
  const nextVersion = stampCiVersion({
    channel: options.channel,
    currentVersion,
    date: options.date,
    preid: options.preid,
    prNumber: options.prNumber,
    runAttempt: options.runAttempt,
    runId: options.runId,
    runNumber: options.runNumber,
  });
  const logPrefix = options.logPrefix ?? "release";

  if (!options.dryRun) {
    packageJson.version = nextVersion;
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    if (process.env.GITHUB_ENV) {
      await appendFile(process.env.GITHUB_ENV, `AMBIENT_CI_VERSION=${nextVersion}\n`);
    }
  }

  console.log(`[${logPrefix}] stamped CI version ${currentVersion} -> ${nextVersion}`);
  return { currentVersion, nextVersion };
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const packageJsonPath = args["package-json"]
    ? path.resolve(args["package-json"])
    : fileURLToPath(new URL("../package.json", import.meta.url));
  await applyStampedVersion({
    channel: args.channel,
    date: args.date || process.env.AMBIENT_STAMP_DATE || undefined,
    dryRun: args["dry-run"] === "true",
    logPrefix: args["log-prefix"],
    packageJsonPath,
    preid: args.preid,
    prNumber: args["pr-number"] ?? process.env.GITHUB_PR_NUMBER,
    runAttempt: args["run-attempt"] ?? process.env.GITHUB_RUN_ATTEMPT,
    runId: args["run-id"] ?? process.env.GITHUB_RUN_ID,
    runNumber: args["run-number"] ?? process.env.GITHUB_RUN_NUMBER,
  });
}
