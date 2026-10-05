/**
 * Allowlisted Ambient hosted realms. Bake still picks a default; a Dev Settings
 * persist may retarget after install. Arbitrary URLs are never accepted.
 */

export type ServerTarget = "staging" | "production";

export const SERVER_TARGET_URLS = {
  production: {
    serverUrl: "https://api.alexandria.so",
    multiplayerUrl: "https://multiplayer-server-production-de2c.up.railway.app",
  },
  staging: {
    serverUrl: "https://ambientserver-staging.up.railway.app",
    multiplayerUrl: "https://multiplayer-server-staging.up.railway.app",
  },
} as const satisfies Record<ServerTarget, { readonly serverUrl: string; readonly multiplayerUrl: string }>;

/** Retired Railway public hostnames. Still resolve to the allowlisted target. */
const LEGACY_MULTIPLAYER_ORIGINS = {
  production: ["https://lighthouse-server-production-de2c.up.railway.app"],
  staging: ["https://lighthouse-server-staging.up.railway.app"],
} as const;

export type ServerTargetUrls = (typeof SERVER_TARGET_URLS)[ServerTarget];

export function parseServerTarget(value: unknown): ServerTarget | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return null;
  const target = raw === "prod" ? "production" : raw;
  return target === "staging" || target === "production" ? target : null;
}

export function normalizeServerTarget(value: unknown): ServerTarget {
  const parsed = parseServerTarget(value);
  if (!parsed) {
    throw new Error(
      `Unknown server target ${JSON.stringify(value)}. Use prod, production, or staging.`,
    );
  }
  return parsed;
}

export function urlsForServerTarget(target: ServerTarget): ServerTargetUrls {
  return SERVER_TARGET_URLS[target];
}

export function serverTargetFromOrigin(value: string | null | undefined): ServerTarget | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    for (const [target, urls] of Object.entries(SERVER_TARGET_URLS)) {
      if (new URL(urls.serverUrl).origin === origin || new URL(urls.multiplayerUrl).origin === origin) {
        return target as ServerTarget;
      }
    }
    for (const [target, origins] of Object.entries(LEGACY_MULTIPLAYER_ORIGINS)) {
      if (origins.some((url) => new URL(url).origin === origin)) {
        return target as ServerTarget;
      }
    }
  } catch {
    return null;
  }
  return null;
}
