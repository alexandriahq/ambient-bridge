import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bridgeRoot = fileURLToPath(new URL("..", import.meta.url));

let app: ElectronApplication;
let page: Page;
let profileDir: string;
let wireServer: Server;
let releaseListRequests = 0;

const requestId = "bridge-e2e-wire-capture";
const requestBase64 = "AQIDBAUGBwgJCgsMDQ4PEA==";

test.beforeAll(async () => {
  wireServer = createServer((request, response) => {
    if (request.url?.startsWith("/releases/apps/ambient-bridge/experimental/")) {
      releaseListRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        product: { slug: "ambient-bridge" },
        releases: [{
          id: "rel_bridge_e2e",
          productSlug: "ambient-bridge",
          version: "0.1.0-experimental.pr310.e2e",
          channel: "experimental",
          platform: process.platform,
          arch: process.arch,
          appId: "com.alexandria.ambient.bridge",
          commitSha: "87bc3a3d257cc8a8aa8824eaec4245ab0babe0aa",
          notes: "Electron runtime experimental build fixture",
          releasedAt: "2026-07-14T08:13:19.039Z",
          artifacts: [{
            kind: process.platform === "win32" ? "exe" : "dmg",
            fileName: "ambient-bridge-e2e",
            contentType: "application/octet-stream",
            sizeBytes: 1,
            sha256: "e2e",
            sha512: null,
            downloadUrl: "https://example.invalid/ambient-bridge-e2e",
            updateUrl: "https://example.invalid/ambient-bridge-e2e",
          }],
        }],
      }));
      return;
    }
    response.writeHead(200, {
      "content-type": "application/ehbp",
      "ehbp-response-nonce": "bridge-electron-e2e-response-nonce",
      "x-tinfoil-request-id": "bridge-electron-e2e-enclave-request",
    });
    response.end(Buffer.from([9, 8, 7, 6]));
  });
  await new Promise<void>((resolve, reject) => {
    wireServer.once("error", reject);
    wireServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = wireServer.address() as AddressInfo;
  const profilePrefix = process.platform === "win32"
    ? join(tmpdir(), "ab-e2e-")
    : "/tmp/ab-e2e-";
  profileDir = await mkdtemp(profilePrefix);
  app = await electron.launch({
    args: [bridgeRoot],
    cwd: bridgeRoot,
    env: {
      ...process.env,
      AMBIENT_BRIDGE_E2E: "1",
      AMBIENT_BRIDGE_E2E_WIRE_URL: `http://127.0.0.1:${address.port}/sealed`,
      AMBIENT_BRIDGE_UPDATE_BASE_URL: `http://127.0.0.1:${address.port}`,
      AMBIENT_BRIDGE_DEV_PROFILE_DIR: profileDir,
      AMBIENT_BRIDGE_DEVTOOLS_PORT: "0",
    },
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => wireServer?.close(() => resolve()));
  if (profileDir) await rm(profileDir, { force: true, recursive: true });
});

test("drives a real sealed capture through the built inspector, production preload, and OS clipboard", async () => {
  await expect(page).toHaveTitle("Ambient Bridge");
  expect(page.url()).toContain("/dist/renderer/index.html");
  await expect(page.getByRole("heading", { name: "Requests", exact: true })).toBeVisible();

  await page.getByRole("button", { name: `Inspect Responses request ${requestId}` }).click();
  const dialog = page.getByRole("dialog", { name: "Responses request" });
  await expect(dialog.getByText("Cipherprint", { exact: true })).toBeVisible();
  await expect(dialog.getByTestId("raw-payload")).toContainText(requestBase64);
  const copyButton = dialog.getByRole("button", { name: "Copy raw sealed payload" });
  await copyButton.click();
  await expect(copyButton).toHaveText("Copied");

  const clipboardText = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(clipboardText).toBe(requestBase64);

  const runtime = await page.evaluate(async () => {
    const api = window.ambientBridge;
    if (!api) return { apiPresent: false } as const;
    return {
      apiPresent: true,
      capture: await api.getWireCapture("bridge-e2e-wire-capture"),
      status: await api.getStatus(),
    } as const;
  });

  expect(runtime.apiPresent).toBe(true);
  if (!runtime.apiPresent) return;
  expect(runtime.status.account.kind).toBe("signed_in");
  expect(runtime.status.socketReady).toBe(true);
  expect(runtime.status.inference.requests).toHaveLength(1);
  expect(runtime.capture.state).toBe("available");
  if (runtime.capture.state === "available") {
    expect(runtime.capture.capture.request.body.base64).toBe(requestBase64);
    expect(runtime.capture.capture.request.body.truncated).toBe(false);
    expect(runtime.capture.capture.request.headers).toContainEqual({ name: "authorization", value: "[redacted]" });
    expect(runtime.capture.capture.response?.body.base64).toBe(Buffer.from([9, 8, 7, 6]).toString("base64"));
  }

  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const contents = window?.webContents as (Electron.WebContents & {
      getLastWebPreferences(): Electron.WebPreferences;
    }) | undefined;
    return contents?.getLastWebPreferences();
  });
  expect(preferences?.contextIsolation).toBe(true);
  expect(preferences?.nodeIntegration).toBe(false);
  expect(preferences?.sandbox).toBe(true);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Bridge Electron E2E.*bridge-electron-e2e@example\.invalid/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Dev", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Experimental builds" })).toBeVisible();
  await expect(page.getByText(/1 experimental build available/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Build version" })).toContainText("0.1.0-experimental.pr310.e2e");
  await page.getByRole("button", { name: "Install selected build" }).click();
  await expect.poll(async () => page.evaluate(async () => (await window.ambientBridge?.getUpdateStatus())?.channel))
    .toBe("experimental");
  expect(releaseListRequests).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Close settings" }).click();

  await page.evaluate(async () => {
    await window.ambientBridge?.signOut();
  });
  await expect(dialog).toBeHidden();
  const afterBoundary = await page.evaluate(async () => {
    return window.ambientBridge?.getWireCapture("bridge-e2e-wire-capture");
  });
  expect(afterBoundary).toEqual({ state: "not_captured" });
});
