import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

describe("release publisher artifact selection", () => {
  it("keeps macOS blockmaps out of a Windows release assembled from mixed artifacts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ambient-release-publisher-"));
    temporaryDirectories.push(root);
    const dist = path.join(root, "dist-packaged");
    const packageJson = path.join(root, "package.json");
    const version = "0.1.0-alpha.55";
    const exeName = `Ambient Setup ${version}.exe`;
    const exe = Buffer.from("windows-installer");

    await mkdir(dist);
    await Promise.all([
      writeFile(packageJson, JSON.stringify({ version })),
      writeFile(path.join(dist, exeName), exe),
      writeFile(path.join(dist, `${exeName}.blockmap`), "windows-blockmap"),
      writeFile(path.join(dist, `Ambient-${version}-arm64-mac.zip.blockmap`), "mac-zip-blockmap"),
      writeFile(path.join(dist, `Ambient-${version}-arm64.dmg.blockmap`), "mac-dmg-blockmap"),
      writeFile(path.join(dist, "alpha.yml"), [
        `version: ${version}`,
        `path: ${exeName}`,
        `sha512: ${createHash("sha512").update(exe).digest("base64")}`,
        "ambientContextVault:",
        "  metadataVersion: 1",
        "  cohort: 1",
        "  schemaVersion: 10",
        "  readerCapabilityEpoch: 1",
        "  writerCapabilityEpoch: 1",
        "",
      ].join("\n")),
    ]);

    const script = path.resolve("scripts/publish-release.mjs");
    const { stdout } = await execFileAsync("node", [
      script,
      `--package-json=${packageJson}`,
      `--dist=${dist}`,
      "--product-slug=ambient-app",
      "--app-id=app.ambient.app",
      "--channel=alpha",
      "--platform=win32",
      "--arch=x64",
      "--commit-sha=test",
      "--dry-run=true",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AMBIENT_CONTEXT_VAULT_BUILD_COHORT: "1",
      },
    });

    expect(stdout).toContain(`/win32/x64/${version}/${exeName}`);
    expect(stdout).toContain(`/win32/x64/${version}/${exeName}.blockmap`);
    expect(stdout).toContain(`/win32/x64/${version}/alpha.yml`);
    expect(stdout).toContain("Context Vault cohort 1 metadata validated");
    expect(stdout).not.toContain("arm64-mac.zip.blockmap");
    expect(stdout).not.toContain("arm64.dmg.blockmap");
  });

  it("refuses to publish an Ambient App feed without capability metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ambient-release-publisher-metadata-"));
    temporaryDirectories.push(root);
    const dist = path.join(root, "dist-packaged");
    const packageJson = path.join(root, "package.json");
    const version = "0.1.0-alpha.56";
    const exeName = `Ambient Setup ${version}.exe`;
    const exe = Buffer.from("windows-installer");
    await mkdir(dist);
    await Promise.all([
      writeFile(packageJson, JSON.stringify({ version })),
      writeFile(path.join(dist, exeName), exe),
      writeFile(path.join(dist, "alpha.yml"), [
        `version: ${version}`,
        `path: ${exeName}`,
        `sha512: ${createHash("sha512").update(exe).digest("base64")}`,
        "",
      ].join("\n")),
    ]);

    const script = path.resolve("scripts/publish-release.mjs");
    await expect(execFileAsync("node", [
      script,
      `--package-json=${packageJson}`,
      `--dist=${dist}`,
      "--product-slug=ambient-app",
      "--app-id=app.ambient.app",
      "--channel=alpha",
      "--platform=win32",
      "--arch=x64",
      "--commit-sha=test",
      "--dry-run=true",
    ], { cwd: process.cwd() })).rejects.toMatchObject({
      stderr: expect.stringContaining("is missing ambientContextVault metadata"),
    });
  });

  it("refuses macOS publication when channel and latest feeds disagree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ambient-release-publisher-mac-metadata-"));
    temporaryDirectories.push(root);
    const dist = path.join(root, "dist-packaged");
    const packageJson = path.join(root, "package.json");
    const version = "0.1.0-alpha.57";
    const zipName = `Ambient-${version}-arm64-mac.zip`;
    const zip = Buffer.from("mac-zip");
    const feed = (cohort: 1 | 2) => [
      `version: ${version}`,
      `path: ${zipName}`,
      `sha512: ${createHash("sha512").update(zip).digest("base64")}`,
      "ambientContextVault:",
      "  metadataVersion: 1",
      `  cohort: ${cohort}`,
      `  schemaVersion: ${cohort === 1 ? 10 : 11}`,
      `  readerCapabilityEpoch: ${cohort}`,
      `  writerCapabilityEpoch: ${cohort}`,
      "",
    ].join("\n");
    await mkdir(dist);
    await Promise.all([
      writeFile(packageJson, JSON.stringify({ version })),
      writeFile(path.join(dist, `Ambient-${version}-arm64.dmg`), "mac-dmg"),
      writeFile(path.join(dist, zipName), zip),
      writeFile(path.join(dist, "alpha-mac.yml"), feed(1)),
      writeFile(path.join(dist, "latest-mac.yml"), feed(2)),
    ]);

    const script = path.resolve("scripts/publish-release.mjs");
    await expect(execFileAsync("node", [
      script,
      `--package-json=${packageJson}`,
      `--dist=${dist}`,
      "--product-slug=ambient-app",
      "--app-id=app.ambient.app",
      "--channel=alpha",
      "--platform=darwin",
      "--arch=arm64",
      "--commit-sha=test",
      "--dry-run=true",
    ], { cwd: process.cwd() })).rejects.toMatchObject({
      stderr: expect.stringContaining("update feeds disagree about Context Vault capabilities"),
    });
  });

  it("refuses a valid feed stamped for a different packaged cohort", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ambient-release-publisher-cohort-"));
    temporaryDirectories.push(root);
    const dist = path.join(root, "dist-packaged");
    const packageJson = path.join(root, "package.json");
    const version = "0.1.0-alpha.58";
    const exeName = `Ambient Setup ${version}.exe`;
    const exe = Buffer.from("windows-installer");
    await mkdir(dist);
    await Promise.all([
      writeFile(packageJson, JSON.stringify({ version })),
      writeFile(path.join(dist, exeName), exe),
      writeFile(path.join(dist, "alpha.yml"), [
        `version: ${version}`,
        `path: ${exeName}`,
        `sha512: ${createHash("sha512").update(exe).digest("base64")}`,
        "ambientContextVault:",
        "  metadataVersion: 1",
        "  cohort: 2",
        "  schemaVersion: 11",
        "  readerCapabilityEpoch: 2",
        "  writerCapabilityEpoch: 2",
        "",
      ].join("\n")),
    ]);

    const script = path.resolve("scripts/publish-release.mjs");
    await expect(execFileAsync("node", [
      script,
      `--package-json=${packageJson}`,
      `--dist=${dist}`,
      "--product-slug=ambient-app",
      "--app-id=app.ambient.app",
      "--channel=alpha",
      "--platform=win32",
      "--arch=x64",
      "--commit-sha=test",
      "--dry-run=true",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, AMBIENT_CONTEXT_VAULT_BUILD_COHORT: "1" },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("feed cohort 2 does not match the packaged cohort 1"),
    });
  });

  it("retries metadata-free only for cohort 1 when publishing to a legacy server", async () => {
    const registrationBodies: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      if (request.method === "PUT") {
        for await (const _chunk of request) {
          // Drain the local S3-compatible request body.
        }
        response.writeHead(200).end();
        return;
      }
      if (request.method === "POST" && request.url === "/admin/releases/apps/ambient-app") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        registrationBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        if (registrationBodies.length === 1) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "validation failed" }));
        } else {
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        }
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Legacy release test server did not bind TCP.");
      const root = await mkdtemp(path.join(os.tmpdir(), "ambient-release-publisher-legacy-"));
      temporaryDirectories.push(root);
      const { dist, packageJson, version } = await writeWindowsAmbientReleaseFixture(root, 1);
      const script = path.resolve("scripts/publish-release.mjs");
      const { stderr } = await execFileAsync("node", [
        script,
        `--package-json=${packageJson}`,
        `--dist=${dist}`,
        "--product-slug=ambient-app",
        "--app-id=app.ambient.app",
        "--channel=alpha",
        "--platform=win32",
        "--arch=x64",
        "--commit-sha=abcdef1",
        `--server-url=http://127.0.0.1:${address.port}`,
      ], {
        cwd: process.cwd(),
        env: publisherEnvironment(1, address.port),
      });

      expect(stderr).toContain("retrying cohort 1 registration without it");
      expect(registrationBodies).toHaveLength(2);
      expect(registrationBodies[0]).toMatchObject({
        version,
        updateMetadata: { ambientContextVault: { cohort: 1, schemaVersion: 10 } },
      });
      expect(registrationBodies[1]).toMatchObject({ version });
      expect(registrationBodies[1]).not.toHaveProperty("updateMetadata");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not strip cohort 2 metadata for a legacy server", async () => {
    const registrationBodies: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      if (request.method === "PUT") {
        for await (const _chunk of request) {
          // Drain the local S3-compatible request body.
        }
        response.writeHead(200).end();
        return;
      }
      if (request.method === "POST" && request.url === "/admin/releases/apps/ambient-app") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        registrationBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "validation failed" }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Legacy release test server did not bind TCP.");
      const root = await mkdtemp(path.join(os.tmpdir(), "ambient-release-publisher-legacy-reject-"));
      temporaryDirectories.push(root);
      const { dist, packageJson } = await writeWindowsAmbientReleaseFixture(root, 2);
      const script = path.resolve("scripts/publish-release.mjs");
      await expect(execFileAsync("node", [
        script,
        `--package-json=${packageJson}`,
        `--dist=${dist}`,
        "--product-slug=ambient-app",
        "--app-id=app.ambient.app",
        "--channel=alpha",
        "--platform=win32",
        "--arch=x64",
        "--commit-sha=abcdef1",
        `--server-url=http://127.0.0.1:${address.port}`,
      ], {
        cwd: process.cwd(),
        env: publisherEnvironment(2, address.port),
      })).rejects.toMatchObject({
        stderr: expect.stringContaining("Release registration failed with 400"),
      });
      expect(registrationBodies).toHaveLength(1);
      expect(registrationBodies[0]).toMatchObject({
        updateMetadata: { ambientContextVault: { cohort: 2, schemaVersion: 11 } },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

async function writeWindowsAmbientReleaseFixture(root: string, cohort: 1 | 2) {
  const dist = path.join(root, "dist-packaged");
  const packageJson = path.join(root, "package.json");
  const version = `0.1.0-alpha.${60 + cohort}`;
  const exeName = `Ambient Setup ${version}.exe`;
  const exe = Buffer.from(`windows-installer-cohort-${cohort}`);
  await mkdir(dist);
  await Promise.all([
    writeFile(packageJson, JSON.stringify({ version })),
    writeFile(path.join(dist, exeName), exe),
    writeFile(path.join(dist, "alpha.yml"), [
      `version: ${version}`,
      `path: ${exeName}`,
      `sha512: ${createHash("sha512").update(exe).digest("base64")}`,
      "ambientContextVault:",
      "  metadataVersion: 1",
      `  cohort: ${cohort}`,
      `  schemaVersion: ${cohort === 1 ? 10 : 11}`,
      `  readerCapabilityEpoch: ${cohort}`,
      `  writerCapabilityEpoch: ${cohort}`,
      "",
    ].join("\n")),
  ]);
  return { dist, packageJson, version };
}

function publisherEnvironment(cohort: 1 | 2, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AMBIENT_CONTEXT_VAULT_BUILD_COHORT: String(cohort),
    RELEASE_ADMIN_TOKEN: "release-admin-token",
    RELEASE_BUCKET_ACCESS_KEY_ID: "test-access-key",
    RELEASE_BUCKET_ENDPOINT: `http://127.0.0.1:${port}`,
    RELEASE_BUCKET_NAME: "releases",
    RELEASE_BUCKET_REGION: "auto",
    RELEASE_BUCKET_SECRET_ACCESS_KEY: "test-secret-key",
  };
}
