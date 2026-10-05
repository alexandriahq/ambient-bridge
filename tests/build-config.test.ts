import { describe, expect, it } from "vitest";

describe("Bridge build configuration", () => {
  it("cleans obsolete Electron outputs while preserving renderer files and baked identities", async () => {
    const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = mkdtempSync(path.join(tmpdir(), "ambient-bridge-bundle-cleanup-"));
    try {
      const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      expect(manifest.scripts["build:electron:bundles"]).toBeTypeOf("string");
      for (const directory of ["scripts", "electron/generated", "dist/renderer"]) {
        mkdirSync(path.join(root, directory), { recursive: true });
      }
      copyFileSync(new URL("../scripts/clean-electron-dist.mjs", import.meta.url), path.join(root, "scripts/clean-electron-dist.mjs"));
      writeFileSync(path.join(root, "package.json"), JSON.stringify({
        type: "module",
        scripts: {
          "build:electron:bundles": manifest.scripts["build:electron:bundles"],
          "build:electron:main": "node emit.mjs main.js",
          "build:electron:preload": "node emit.mjs preload.cjs",
          "generate:build-config": 'node -e "process.exit(79)"',
        },
      }));
      writeFileSync(path.join(root, "emit.mjs"), `
        import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
        mkdirSync("dist/electron", { recursive: true });
        writeFileSync("dist/electron/" + process.argv[2], readFileSync("electron/generated/build-config.ts"));
      `);
      writeFileSync(path.join(root, "dist/renderer/index.html"), "existing renderer");
      for (const suffix of ["", ".local", ".dev"]) {
        const identity = `export const BUILD_BRIDGE_APP_ID = "com.alexandria.ambient.bridge${suffix}";`;
        writeFileSync(path.join(root, "electron/generated/build-config.ts"), identity);
        mkdirSync(path.join(root, "dist/electron/obsolete"), { recursive: true });
        writeFileSync(path.join(root, "dist/electron/stale.js"), "obsolete root module");
        writeFileSync(path.join(root, "dist/electron/obsolete/chunk.js"), "obsolete nested module");
        const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["run", "build:electron:bundles"], {
          cwd: root, encoding: "utf8", shell: process.platform === "win32", timeout: 15_000,
          env: { ...process.env, AMBIENT_DESKTOP_VARIANT: "" },
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(readdirSync(path.join(root, "dist/electron")).sort()).toEqual(["main.js", "preload.cjs"]);
        for (const file of ["electron/generated/build-config.ts", "dist/electron/main.js", "dist/electron/preload.cjs"]) {
          expect(readFileSync(path.join(root, file), "utf8")).toBe(identity);
        }
        expect(readFileSync(path.join(root, "dist/renderer/index.html"), "utf8")).toBe("existing renderer");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("bakes the release channel and exact source commit into the runtime identity", async () => {
    const {
      resolveBuildCommitSha,
      resolveBuildReleaseChannel,
    } = await import("../scripts/generate-build-config.mjs");

    expect(resolveBuildReleaseChannel({ RELEASE_CHANNEL: " experimental " })).toBe("experimental");
    expect(resolveBuildReleaseChannel({ AMBIENT_BRIDGE_RELEASE_CHANNEL: "alpha" })).toBe("alpha");
    expect(resolveBuildReleaseChannel({})).toBe("alpha");
    // Dev and Local Bridges pair with an App on the `local` channel.
    expect(resolveBuildReleaseChannel({ AMBIENT_DESKTOP_VARIANT: "dev" })).toBe("local");
    expect(resolveBuildReleaseChannel({ AMBIENT_DESKTOP_VARIANT: " Local " })).toBe("local");
    expect(resolveBuildReleaseChannel({ AMBIENT_DESKTOP_VARIANT: "dev", AMBIENT_BRIDGE_RELEASE_CHANNEL: "alpha" })).toBe("alpha");
    expect(resolveBuildCommitSha({
      GIT_COMMIT_SHA: "A301FC27AFA17A51618419E0CE8120C8CBA5D169",
    }, "0000000000000000000000000000000000000000")).toBe(
      "a301fc27afa17a51618419e0ce8120c8cba5d169",
    );
    expect(resolveBuildCommitSha({}, "21f9b0e78c68c83691b90c70a2137d77a1dd40c7")).toBe(
      "21f9b0e78c68c83691b90c70a2137d77a1dd40c7",
    );
  });

  it("keeps the bake allowlist identical to the shared hosted-realm table", async () => {
    const { SERVER_TARGET_URLS } = await import("@ambient/shared/server-targets");
    const { SERVER_TARGETS } = await import("../scripts/generate-build-config.mjs");
    expect(SERVER_TARGETS).toEqual(SERVER_TARGET_URLS);
  });

  it("keeps every normal release channel on the production account realm", async () => {
    const {
      PROD_MULTIPLAYER_URL,
      PROD_SERVER_URL,
      resolveBuildBakeMarker,
      resolveBuildMultiplayerUrl,
      resolveBuildServerUrl,
    } = await import("../scripts/generate-build-config.mjs");

    expect(resolveBuildServerUrl({})).toBe(PROD_SERVER_URL);
    expect(resolveBuildServerUrl({ AMBIENT_BRIDGE_RELEASE_CHANNEL: "experimental" })).toBe(PROD_SERVER_URL);
    expect(resolveBuildServerUrl({ RELEASE_CHANNEL: "alpha" })).toBe(PROD_SERVER_URL);
    expect(resolveBuildServerUrl({ AMBIENT_BRIDGE_RELEASE_CHANNEL: "nightly" })).toBe(PROD_SERVER_URL);
    expect(PROD_MULTIPLAYER_URL).toBe("https://multiplayer-server-production-de2c.up.railway.app");
    expect(resolveBuildMultiplayerUrl({})).toBe(PROD_MULTIPLAYER_URL);
    expect(resolveBuildMultiplayerUrl({ AMBIENT_BRIDGE_RELEASE_CHANNEL: "experimental" })).toBe(PROD_MULTIPLAYER_URL);
    expect(resolveBuildMultiplayerUrl({ RELEASE_CHANNEL: "alpha" })).toBe(PROD_MULTIPLAYER_URL);
    expect(resolveBuildBakeMarker({})).toBe("ambient-bake:production");
    expect(resolveBuildBakeMarker({ AMBIENT_BRIDGE_RELEASE_CHANNEL: "nightly" })).toBe(
      "ambient-bake:production",
    );
    expect(resolveBuildBakeMarker({ AMBIENT_BRIDGE_RELEASE_CHANNEL: "experimental" })).toBe(
      "ambient-bake:production",
    );
  });

  it("bakes Dev onto staging and Local onto the production account realm", async () => {
    const {
      PROD_MULTIPLAYER_URL,
      PROD_SERVER_URL,
      STAGING_MULTIPLAYER_URL,
      STAGING_SERVER_URL,
      resolveBuildBakeMarker,
      resolveBuildMultiplayerUrl,
      resolveBuildServerUrl,
    } = await import(
      "../scripts/generate-build-config.mjs"
    );

    expect(resolveBuildServerUrl({ AMBIENT_DESKTOP_VARIANT: "dev" })).toBe(STAGING_SERVER_URL);
    expect(resolveBuildServerUrl({ AMBIENT_DESKTOP_VARIANT: "local" })).toBe(PROD_SERVER_URL);
    expect(resolveBuildServerUrl({
      AMBIENT_DESKTOP_VARIANT: "dev",
      AMBIENT_BRIDGE_RELEASE_CHANNEL: "experimental",
    })).toBe(STAGING_SERVER_URL);
    expect(resolveBuildServerUrl({ AMBIENT_DESKTOP_VARIANT: "standard" })).toBe(PROD_SERVER_URL);
    expect(resolveBuildMultiplayerUrl({ AMBIENT_DESKTOP_VARIANT: "dev" })).toBe(STAGING_MULTIPLAYER_URL);
    expect(resolveBuildMultiplayerUrl({ AMBIENT_DESKTOP_VARIANT: "local" })).toBe(PROD_MULTIPLAYER_URL);
    expect(resolveBuildMultiplayerUrl({
      AMBIENT_DESKTOP_VARIANT: "dev",
      AMBIENT_BRIDGE_RELEASE_CHANNEL: "experimental",
    })).toBe(STAGING_MULTIPLAYER_URL);
    expect(resolveBuildMultiplayerUrl({ AMBIENT_DESKTOP_VARIANT: "standard" })).toBe(PROD_MULTIPLAYER_URL);
    expect(resolveBuildBakeMarker({ AMBIENT_DESKTOP_VARIANT: "dev" })).toBe("ambient-bake:staging");
    expect(resolveBuildBakeMarker({ AMBIENT_DESKTOP_VARIANT: "local" })).toBe("ambient-bake:production");
    expect(resolveBuildBakeMarker({ AMBIENT_DESKTOP_VARIANT: "standard" })).toBe(
      "ambient-bake:production",
    );
  });

  it("lets AMBIENT_SERVER_TARGET retarget Dev and Local onto a hosted realm", async () => {
    const {
      PROD_MULTIPLAYER_URL,
      PROD_SERVER_URL,
      STAGING_MULTIPLAYER_URL,
      STAGING_SERVER_URL,
      normalizeServerTarget,
      resolveBuildMultiplayerUrl,
      resolveBuildServerUrl,
    } = await import("../scripts/generate-build-config.mjs");

    expect(normalizeServerTarget(" production ")).toBe("production");
    expect(normalizeServerTarget("prod")).toBe("production");
    expect(normalizeServerTarget("STAGING")).toBe("staging");
    expect(normalizeServerTarget("")).toBeNull();
    expect(() => normalizeServerTarget("local")).toThrow(/prod, production, or staging/);

    expect(resolveBuildServerUrl({
      AMBIENT_DESKTOP_VARIANT: "dev",
      AMBIENT_SERVER_TARGET: "prod",
    })).toBe(PROD_SERVER_URL);
    expect(resolveBuildMultiplayerUrl({
      AMBIENT_DESKTOP_VARIANT: "local",
      AMBIENT_SERVER_TARGET: "prod",
    })).toBe(PROD_MULTIPLAYER_URL);
    expect(resolveBuildServerUrl({
      AMBIENT_DESKTOP_VARIANT: "dev",
      AMBIENT_SERVER_TARGET: "production",
    })).toBe(PROD_SERVER_URL);
    expect(resolveBuildMultiplayerUrl({
      AMBIENT_DESKTOP_VARIANT: "local",
      AMBIENT_SERVER_TARGET: "PRODUCTION",
    })).toBe(PROD_MULTIPLAYER_URL);
    expect(resolveBuildServerUrl({
      AMBIENT_DESKTOP_VARIANT: "local",
      AMBIENT_SERVER_TARGET: "staging",
    })).toBe(STAGING_SERVER_URL);
    expect(resolveBuildMultiplayerUrl({
      AMBIENT_DESKTOP_VARIANT: "local",
      AMBIENT_SERVER_TARGET: "staging",
    })).toBe(STAGING_MULTIPLAYER_URL);
    expect(resolveBuildServerUrl({
      AMBIENT_DESKTOP_VARIANT: "dev",
      AMBIENT_SERVER_TARGET: "production",
      AMBIENT_BRIDGE_BUILD_SERVER_URL: "http://localhost:3000/",
    })).toBe("http://localhost:3000");
    expect(() => resolveBuildServerUrl({
      AMBIENT_SERVER_TARGET: "preview",
    })).toThrow(/AMBIENT_SERVER_TARGET/);
  });

  it("allows an explicit build-time server override without leaking trailing slashes", async () => {
    const {
      PROD_MULTIPLAYER_URL,
      PROD_SERVER_URL,
      resolveBuildMultiplayerUrl,
      resolveBuildServerUrl,
    } = await import("../scripts/generate-build-config.mjs");

    expect(resolveBuildServerUrl({
      AMBIENT_BRIDGE_BUILD_SERVER_URL: "https://ambientserver-staging.up.railway.app///",
      AMBIENT_BRIDGE_RELEASE_CHANNEL: "experimental",
    })).toBe("https://ambientserver-staging.up.railway.app");
    expect(resolveBuildServerUrl({
      AMBIENT_DESKTOP_VARIANT: "dev",
      AMBIENT_BRIDGE_BUILD_SERVER_URL: "https://api.alexandria.so/",
    })).toBe(PROD_SERVER_URL);
    expect(resolveBuildMultiplayerUrl({
      AMBIENT_BRIDGE_BUILD_MULTIPLAYER_URL: "https://multiplayer-server-staging.up.railway.app///",
      AMBIENT_BRIDGE_RELEASE_CHANNEL: "experimental",
    })).toBe("https://multiplayer-server-staging.up.railway.app");
    expect(resolveBuildMultiplayerUrl({
      AMBIENT_DESKTOP_VARIANT: "dev",
      AMBIENT_BRIDGE_BUILD_MULTIPLAYER_URL: "https://multiplayer-server-production-de2c.up.railway.app/",
    })).toBe(PROD_MULTIPLAYER_URL);
  });

});
