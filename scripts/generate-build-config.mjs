#!/usr/bin/env node
// Bakes build-time configuration into the bridge bundle.
//
// Electron main is bundled with Vite. Build-time environment variables are
// not available to the packaged app at runtime, so any
// value that must differ per release channel (e.g. the default API/inference
// server, or the Multiplayer ingest origin) has to be written into a source
// module before bundling. This script does exactly that: it resolves the
// baked default server URL and Multiplayer ingest URL from the release channel
// and writes electron/generated/build-config.ts.
//
// The baked server URL is the default Ambient API origin. After install, Dev
// Settings may persist an allowlisted staging|production retarget in
// userData/server-target.json. Arbitrary URLs are never accepted. Multiplayer
// ingest uses the matching origin. Dev bakes staging while packaged Local
// builds bake production unless AMBIENT_SERVER_TARGET or an explicit
// AMBIENT_BRIDGE_BUILD_SERVER_URL / AMBIENT_BRIDGE_BUILD_MULTIPLAYER_URL is set.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(scriptDir, "../electron/generated/build-config.ts");

// Bare / experimental / production Bridge builds use the production API and
// production Multiplayer ingest by default so they match a normal release.
// Dev desktop variants bake staging so source runs do not share the prod
// account realm. Local follows normal releases onto production. An explicit
// AMBIENT_BRIDGE_BUILD_SERVER_URL / AMBIENT_BRIDGE_BUILD_MULTIPLAYER_URL still
// wins. AMBIENT_SERVER_TARGET=prod|production|staging is the named hosted-realm
// bake override for Dev/Local. Runtime switching is the Dev Settings persist.
export const PROD_SERVER_URL = "https://api.alexandria.so";
export const STAGING_SERVER_URL = "https://ambientserver-staging.up.railway.app";
export const PROD_MULTIPLAYER_URL = "https://multiplayer-server-production-de2c.up.railway.app";
export const STAGING_MULTIPLAYER_URL = "https://multiplayer-server-staging.up.railway.app";

export const SERVER_TARGETS = Object.freeze({
  production: { serverUrl: PROD_SERVER_URL, multiplayerUrl: PROD_MULTIPLAYER_URL },
  staging: { serverUrl: STAGING_SERVER_URL, multiplayerUrl: STAGING_MULTIPLAYER_URL },
});

function normalize(url) {
  return url.trim().replace(/\/+$/, "");
}

export function normalizeServerTarget(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return null;
  const target = raw === "prod" ? "production" : raw;
  if (!(target in SERVER_TARGETS)) {
    throw new Error(
      `Unknown AMBIENT_SERVER_TARGET=${JSON.stringify(value)}. Use prod, production, or staging.`,
    );
  }
  return target;
}

function resolveNamedServerTarget(env = process.env) {
  return normalizeServerTarget(env.AMBIENT_SERVER_TARGET);
}

// Resolves the server origin baked into a build for the given environment. Kept
// pure and exported so the packaged-app smoke test can assert against the exact
// same logic that produced the bundle.
export function resolveBuildServerUrl(env = process.env) {
  const explicit = env.AMBIENT_BRIDGE_BUILD_SERVER_URL?.trim();
  if (explicit) return normalize(explicit);
  const namedTarget = resolveNamedServerTarget(env);
  if (namedTarget) return SERVER_TARGETS[namedTarget].serverUrl;
  const desktopVariant = env.AMBIENT_DESKTOP_VARIANT?.trim().toLowerCase();
  if (desktopVariant === "dev") {
    return STAGING_SERVER_URL;
  }
  return PROD_SERVER_URL;
}

export function resolveBuildMultiplayerUrl(env = process.env) {
  const explicit = env.AMBIENT_BRIDGE_BUILD_MULTIPLAYER_URL?.trim();
  if (explicit) return normalize(explicit);
  const namedTarget = resolveNamedServerTarget(env);
  if (namedTarget) return SERVER_TARGETS[namedTarget].multiplayerUrl;
  const desktopVariant = env.AMBIENT_DESKTOP_VARIANT?.trim().toLowerCase();
  if (desktopVariant === "dev") {
    return STAGING_MULTIPLAYER_URL;
  }
  return PROD_MULTIPLAYER_URL;
}

// Distinct from the allowlisted URLs in `@ambient/shared/server-targets`.
// Packaged smoke looks for this marker so Nightly/Stable can embed both
// hosted realms for Dev Settings retarget without failing the bake check.
export function resolveBuildBakeMarker(env = process.env) {
  const serverUrl = resolveBuildServerUrl(env);
  if (serverUrl === STAGING_SERVER_URL) return "ambient-bake:staging";
  if (serverUrl === PROD_SERVER_URL) return "ambient-bake:production";
  return "ambient-bake:custom";
}

export function resolveBuildReleaseChannel(env = process.env) {
  // Dev and Local Apps infer the `local` channel from their `-local` version.
  // Their Bridge must bake the same channel, or the App rejects it as a
  // mismatched companion and tries to install a `local` release that does
  // not exist. Release builds always set the channel explicitly.
  const variant = env.AMBIENT_DESKTOP_VARIANT?.trim().toLowerCase();
  const fallback = variant === "dev" || variant === "local" ? "local" : "alpha";
  return (env.AMBIENT_BRIDGE_RELEASE_CHANNEL ?? env.RELEASE_CHANNEL ?? fallback).trim() || fallback;
}

export function resolveBuildCommitSha(env = process.env, fallbackCommitSha = gitCommitSha()) {
  const candidate = (env.GIT_COMMIT_SHA ?? fallbackCommitSha).trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(candidate) ? candidate : "unknown";
}

function generate(env = process.env) {
  const channel = resolveBuildReleaseChannel(env);
  const commitSha = resolveBuildCommitSha(env);
  const serverUrl = resolveBuildServerUrl(env);
  const multiplayerUrl = resolveBuildMultiplayerUrl(env);
  const bakeMarker = resolveBuildBakeMarker(env);
  // Three desktop identities: bare (prod/experimental), `.local` (packaged QA),
  // `.dev` (source / electron.exe). Never let unpackaged runs bake the bare id
  // into a Start Menu AUMID — see #520.
  const desktopVariant = env.AMBIENT_DESKTOP_VARIANT?.trim().toLowerCase();
  const localDesktopBuild = desktopVariant === "local";
  const devDesktopBuild = desktopVariant === "dev";
  const buildAppId = localDesktopBuild
    ? "com.alexandria.ambient.bridge.local"
    : devDesktopBuild
      ? "com.alexandria.ambient.bridge.dev"
      : "com.alexandria.ambient.bridge";
  const buildAppName = localDesktopBuild
    ? "Ambient Bridge Local"
    : devDesktopBuild
      ? "Ambient Bridge Dev"
      : "Ambient Bridge";

  const contents = `// AUTO-GENERATED by scripts/generate-build-config.mjs — do not edit by hand.
// Regenerate with \`pnpm generate:build-config\`. Baked at build time from the
// release channel; this is the default Ambient API server URL and Multiplayer
// ingest origin. An allowlisted userData persist can retarget after install.
export const BUILD_DEFAULT_SERVER_URL = ${JSON.stringify(serverUrl)};
export const BUILD_DEFAULT_MULTIPLAYER_URL = ${JSON.stringify(multiplayerUrl)};
export const BUILD_BAKE_MARKER = ${JSON.stringify(bakeMarker)};
export const BUILD_RELEASE_CHANNEL = ${JSON.stringify(channel)};
export const BUILD_COMMIT_SHA = ${JSON.stringify(commitSha)};
export const BUILD_APP_ID = ${JSON.stringify(buildAppId)};
export const BUILD_APP_NAME = ${JSON.stringify(buildAppName)};
`;

  mkdirSync(dirname(outFile), { recursive: true });

  // Avoid rewriting (and dirtying mtimes / triggering watchers) when unchanged.
  let existing = "";
  try {
    existing = readFileSync(outFile, "utf8");
  } catch {
    // no existing file
  }
  if (existing !== contents) {
    writeFileSync(outFile, contents);
  }

  console.log(
    `[generate-build-config] channel=${channel} commit=${commitSha.slice(0, 12)} bake=${bakeMarker} → BUILD_DEFAULT_SERVER_URL=${serverUrl} BUILD_DEFAULT_MULTIPLAYER_URL=${multiplayerUrl}`,
  );
}

function gitCommitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve(scriptDir, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

// Only write the file when invoked directly (pnpm generate:build-config), not
// when imported for resolveBuildServerUrl / resolveBuildMultiplayerUrl.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generate();
}
