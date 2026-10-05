import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseServerTarget,
  serverTargetFromOrigin,
  urlsForServerTarget,
  type ServerTarget,
} from "@ambient/shared/server-targets";

export const SERVER_TARGET_FILENAME = "server-target.json";

export type ActiveServerTarget = {
  readonly target: ServerTarget | null;
  readonly source: "persist" | "bake";
  readonly serverUrl: string;
  readonly multiplayerUrl: string;
};

export function serverTargetPath(userDataDir: string): string {
  return join(userDataDir, SERVER_TARGET_FILENAME);
}

export function loadPersistedServerTarget(userDataDir: string): ServerTarget | null {
  try {
    const raw = readFileSync(serverTargetPath(userDataDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parseServerTarget((parsed as { target?: unknown }).target);
  } catch {
    return null;
  }
}

export function persistServerTarget(userDataDir: string, target: ServerTarget): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    serverTargetPath(userDataDir),
    `${JSON.stringify({ target })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export function resolveActiveServerTarget(input: {
  readonly userDataDir: string;
  readonly bakedServerUrl: string;
  readonly bakedMultiplayerUrl: string;
}): ActiveServerTarget {
  const persisted = loadPersistedServerTarget(input.userDataDir);
  if (persisted) {
    const urls = urlsForServerTarget(persisted);
    return {
      multiplayerUrl: urls.multiplayerUrl,
      serverUrl: urls.serverUrl,
      source: "persist",
      target: persisted,
    };
  }
  return {
    multiplayerUrl: input.bakedMultiplayerUrl,
    serverUrl: input.bakedServerUrl,
    source: "bake",
    target: serverTargetFromOrigin(input.bakedServerUrl),
  };
}
