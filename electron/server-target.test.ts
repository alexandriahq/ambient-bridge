import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_TARGET_URLS } from "@ambient/shared/server-targets";
import {
  loadPersistedServerTarget,
  persistServerTarget,
  resolveActiveServerTarget,
} from "./server-target.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempUserData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ambient-server-target-"));
  tempDirs.push(dir);
  return dir;
}

describe("server target persist", () => {
  it("ignores a missing or invalid persist file", async () => {
    const userDataDir = await tempUserData();
    expect(loadPersistedServerTarget(userDataDir)).toBeNull();
    persistServerTarget(userDataDir, "staging");
    expect(loadPersistedServerTarget(userDataDir)).toBe("staging");
  });

  it("rejects an arbitrary persist URL", async () => {
    const userDataDir = await tempUserData();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(userDataDir, "server-target.json"), JSON.stringify({
      target: "https://evil.example",
    }));
    expect(loadPersistedServerTarget(userDataDir)).toBeNull();
  });

  it("lets persist win over the baked default", async () => {
    const userDataDir = await tempUserData();
    persistServerTarget(userDataDir, "staging");
    expect(resolveActiveServerTarget({
      bakedMultiplayerUrl: SERVER_TARGET_URLS.production.multiplayerUrl,
      bakedServerUrl: SERVER_TARGET_URLS.production.serverUrl,
      userDataDir,
    })).toEqual({
      multiplayerUrl: SERVER_TARGET_URLS.staging.multiplayerUrl,
      serverUrl: SERVER_TARGET_URLS.staging.serverUrl,
      source: "persist",
      target: "staging",
    });
  });

  it("follows the bake when nothing is persisted, including a custom localhost bake", async () => {
    const userDataDir = await tempUserData();
    expect(resolveActiveServerTarget({
      bakedMultiplayerUrl: SERVER_TARGET_URLS.production.multiplayerUrl,
      bakedServerUrl: SERVER_TARGET_URLS.production.serverUrl,
      userDataDir,
    })).toMatchObject({
      source: "bake",
      target: "production",
    });
    expect(resolveActiveServerTarget({
      bakedMultiplayerUrl: "http://127.0.0.1:3100",
      bakedServerUrl: "http://localhost:3000",
      userDataDir,
    })).toEqual({
      multiplayerUrl: "http://127.0.0.1:3100",
      serverUrl: "http://localhost:3000",
      source: "bake",
      target: null,
    });
  });
});
