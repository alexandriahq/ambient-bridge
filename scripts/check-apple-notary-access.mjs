#!/usr/bin/env node
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isMissingAppleAgreementError, summarizeNotaryOutput } from "./notary-preflight-core.mjs";

const execFileAsync = promisify(execFile);

if (isMain()) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[apple-notary preflight] ${message}`);
    process.exit(1);
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  if (process.platform !== "darwin") {
    throw new Error("Apple notarization preflight must run on macOS.");
  }

  const keyPath = requiredEnv("APPLE_API_KEY");
  const keyId = requiredEnv("APPLE_API_KEY_ID");
  const issuer = requiredEnv("APPLE_API_ISSUER");
  await assertFile(keyPath, "Apple notarization API key");

  await checkNotaryAccess({ issuer, keyId, keyPath });
  console.log("[apple-notary preflight] notarytool access verified");
}

export async function checkNotaryAccess({ issuer, keyId, keyPath }) {
  try {
    await execFileAsync("xcrun", [
      "notarytool",
      "history",
      "--key",
      keyPath,
      "--key-id",
      keyId,
      "--issuer",
      issuer,
    ], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 2 * 60_000,
    });
  } catch (error) {
    const output = commandOutput(error);
    if (isMissingAppleAgreementError(output)) {
      throw new Error(
        "Apple notarization is blocked before packaging: a required Apple Developer agreement is missing or expired for the configured team. Accept the current Apple Developer/App Store Connect agreements, then rerun the release workflow."
      );
    }

    throw new Error(`notarytool history failed during Apple notarization preflight: ${summarizeNotaryOutput(output) || errorMessage(error)}`);
  }
}

export { isMissingAppleAgreementError, summarizeNotaryOutput };

function commandOutput(error) {
  if (!error || typeof error !== "object") return "";
  const stdout = "stdout" in error ? String(error.stdout ?? "") : "";
  const stderr = "stderr" in error ? String(error.stderr ?? "") : "";
  return `${stdout}\n${stderr}`.trim();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function assertFile(filePath, label) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new Error(`${label} was not found at ${filePath}`);
  }
  if (!info.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

function printHelp() {
  console.log(`Usage: node bridge/scripts/check-apple-notary-access.mjs

Checks whether the configured App Store Connect API key can reach Apple's
notary service before the release workflow spends time packaging artifacts.

Required environment variables:
  APPLE_API_KEY       Path to AuthKey_<id>.p8
  APPLE_API_KEY_ID    App Store Connect API key id
  APPLE_API_ISSUER    App Store Connect issuer UUID
`);
}
