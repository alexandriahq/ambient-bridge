import { expect, test, type Page } from "@playwright/test";
import type { BridgeStatus } from "../src/lib/bridge-api";

const rendererErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  rendererErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // Vite mock-renderer cold starts can 504 on stale optimize-dep entries; not product signal.
    if (text.includes("Outdated Optimize Dep")) return;
    errors.push(`console: ${text}`);
  });
});

test.afterEach(async ({ page }) => {
  expect(rendererErrors.get(page) ?? []).toEqual([]);
});

test("shows an honest initial loading state before Bridge status is available", async ({ page }) => {
  await page.goto("/?bridgeMockStatusDelayMs=30000");
  // Full-page loading replaces the Requests shell until the first status lands.
  await expect(page.getByRole("status").filter({ hasText: "Loading Bridge status" })).toBeVisible();
  await expect(page.getByText("Reading the local account, connection, and request state.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Requests", exact: true })).toHaveCount(0);
});

test("shows the full request list and opens request inspection", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Ambient Bridge");
  await expect(page.getByRole("status", { name: /Bridge ready.*api\.alexandria\.so.*1 of 2 attested/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Requests", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "About", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Security", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Runtime", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Recent activity", exact: true })).toHaveCount(0);
  const windowShell = page.getByTestId("bridge-window-shell");
  await expect(windowShell).toHaveCSS("padding", "0px");
  await expect(windowShell).toHaveCSS("border-width", "0px");
  await expect(windowShell).toHaveCSS("border-radius", "0px");
  const insetPane = page.getByTestId("bridge-inset-pane");
  await expect(insetPane).toHaveCSS("border-radius", "14px");
  await expect(insetPane).not.toHaveCSS("box-shadow", "none");
  await expect(page.getByTestId("request-list")).toHaveCSS("overflow-y", "auto");

  const toolbar = page.getByTestId("bridge-toolbar");
  const toolbarStatus = page.getByTestId("bridge-toolbar-status");
  const toolbarAccount = page.getByTestId("bridge-toolbar-account");
  const toolbarBox = await toolbar.boundingBox();
  const statusBox = await toolbarStatus.boundingBox();
  const accountBox = await toolbarAccount.boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  expect(accountBox).not.toBeNull();
  expect(statusBox!.x + statusBox!.width / 2).toBeCloseTo(toolbarBox!.x + toolbarBox!.width / 2, 0);
  expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(accountBox!.x);

  await page.getByRole("button", { name: /Inspect Chat request req-1/ }).click();
  const dialog = page.getByRole("dialog", { name: "Chat request" });
  await expect(dialog).toBeVisible();
  const details = page.getByTestId("request-details");
  await expect(dialog.getByRole("img", { name: /SSH-style randomart generated from the captured ciphertext fingerprint/ })).toBeVisible();
  await expect(page.getByTestId("cipher-fingerprint")).toHaveText(/^SHA256:/);
  await expect(details).toHaveCSS("overflow-y", "auto");
  await expect(details).toHaveAttribute("role", "region");
  await expect(details).toHaveAttribute("tabindex", "0");
  await expect(dialog.getByText("chunk-analysis", { exact: true }).first()).toBeVisible();
  const rawPayload = dialog.getByTestId("raw-payload");
  await expect(rawPayload).toBeVisible();
  await expect(rawPayload).toHaveAttribute("role", "region");
  await expect(rawPayload).toHaveAttribute("tabindex", "0");
  expect((await rawPayload.textContent())?.length).toBeGreaterThan(10_000);
  await expect(rawPayload).toHaveCSS("overflow-y", "visible");
  const copyRawButton = dialog.getByRole("button", { name: "Copy raw sealed payload" });
  await expect(copyRawButton).toBeVisible();
  await copyRawButton.click();
  await expect(copyRawButton).toHaveText("Copied");
  const summary = dialog.getByTestId("cipher-summary");
  const scrollThumb = dialog.getByTestId("request-scroll-thumb");
  const summaryTop = await summary.evaluate((element) => element.getBoundingClientRect().top);
  await details.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(details).toHaveClass(/is-scrolling/);
  await expect(scrollThumb).toHaveClass(/opacity-100/);
  expect(await scrollThumb.evaluate((element) => element.getBoundingClientRect().width)).toBe(12);
  expect(await details.evaluate((element) => (element as HTMLElement).offsetWidth - element.clientWidth)).toBe(0);
  expect(await summary.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(summaryTop, 0);
  await expect(details).not.toHaveClass(/is-scrolling/, { timeout: 1_500 });
  await expect(scrollThumb).toHaveClass(/opacity-0/);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("plaintext routing does not display the retired notice", async ({ page }) => {
  await page.goto("/?bridgeMockPlaintext=1");
  await expect(page.getByText("Inference requests and transport status through this Bridge.")).toBeVisible();
  await expect(page.locator("[data-plaintext-inference-warning]")).toHaveCount(0);
  await page.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("[data-plaintext-inference-warning]")).toHaveCount(0);
});

test("keeps the centered toolbar status clear of controls in a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 600 });
  // Pin darwin mock chrome so Linux CI does not paint win32/linux window
  // controls into the account cluster and fail the clearance geometry.
  await page.goto("/?mockPlatform=darwin");

  const toolbarBox = await page.getByTestId("bridge-toolbar").boundingBox();
  const statusBox = await page.getByTestId("bridge-toolbar-status").boundingBox();
  const accountBox = await page.getByTestId("bridge-toolbar-account").boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  expect(accountBox).not.toBeNull();
  expect(statusBox!.x + statusBox!.width / 2).toBeCloseTo(toolbarBox!.x + toolbarBox!.width / 2, 0);
  expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(accountBox!.x);
  await expect(page.getByTestId("bridge-toolbar-status").getByText("api.alexandria.so", { exact: true })).toBeHidden();
});

test("opens About in the main Bridge pane", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Mock User you@example.com", exact: true }).click();
  await page.getByRole("menuitem", { name: "About", exact: true }).click();
  await expect(page.getByRole("button", { name: "About", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
  await expect(page.getByText("Ambient Bridge", { exact: true })).toBeVisible();
  await expect(page.getByText(/Ambient installs matching Experimental App and Bridge builds/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Check for updates" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restart and install" })).toHaveCount(0);
  await page.getByRole("button", { name: "Uninstall Ambient Bridge" }).click();
  const uninstallDialog = page.getByRole("dialog", { name: "Uninstall Ambient Bridge?" });
  await expect(uninstallDialog).toBeVisible();
  await expect(uninstallDialog.getByText("Your Bridge account and local settings will remain on this Mac.")).toBeVisible();
  await expect(uninstallDialog.getByText("Uninstall is available in packaged Bridge builds.")).toBeVisible();
  await expect(uninstallDialog.getByRole("button", { name: "Move to Trash and quit" })).toBeDisabled();
  await uninstallDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(uninstallDialog).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Requests", exact: true }).click();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toBeVisible();
});

test("does not show a Bridge update toast when the mock reports a download", async ({ page }) => {
  await page.goto("/?bridgeMockUpdate=downloading");

  await expect(page.getByTestId("bridge-window-shell")).toBeVisible();
  await expect(page.getByTestId("ambient-action-toast")).toHaveCount(0);
  await expect(page.getByText("Downloading the update (60%).")).toHaveCount(0);
});

test("does not offer Experimental installs from Bridge About", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Mock User you@example.com", exact: true }).click();
  await page.getByRole("menuitem", { name: "About", exact: true }).click();
  await expect(page.getByRole("button", { name: "Dev", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Experimental builds" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Experimental builds" })).toHaveCount(0);
  await expect(page.getByText(/Ambient installs matching Experimental App and Bridge builds/)).toBeVisible();
});

test("keeps pending wire capture honest and refreshable", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /Inspect Responses request req-2/ }).click();
  const dialog = page.getByRole("dialog", { name: "Responses request" });
  await expect(dialog.getByText(/sealed request is still being captured/i)).toBeVisible();
  await expect(dialog.getByTestId("raw-payload")).toHaveCount(0);
});

test("labels truncated ciphertext fingerprints and copied data as a prefix", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /Inspect Transcription request req-3/ }).click();
  const dialog = page.getByRole("dialog", { name: "Transcription request" });
  await expect(dialog.getByText("Prefix cipherprint", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Truncated", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/captured · incomplete/)).toBeVisible();
  const rawPayload = dialog.getByTestId("raw-payload");
  expect((await rawPayload.textContent())?.length).toBeGreaterThan(20_000);
  const copyPrefix = dialog.getByRole("button", { name: "Copy captured sealed payload prefix" });
  await copyPrefix.click();
  await expect(copyPrefix).toHaveText("Copied");
});

test("distinguishes an evicted production capture from one never captured", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const api = window.ambientBridge;
    if (!api) throw new Error("Mock Bridge API unavailable");
    api.getWireCapture = async () => ({ state: "evicted" });
  });

  await page.getByRole("button", { name: /Inspect Chat request req-1/ }).click();
  await expect(page.getByRole("dialog", { name: "Chat request" }).getByText(/bounded in-memory copy has since expired/i)).toBeVisible();
});

test("releases an open ciphertext inspector when its status history is cleared", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Inspect Chat request req-1/ }).click();
  const dialog = page.getByRole("dialog", { name: "Chat request" });
  await expect(dialog.getByTestId("raw-payload")).toBeVisible();

  await page.evaluate(() => {
    const api = window.ambientBridge as
      | (NonNullable<typeof window.ambientBridge> & { clearRequestLogForTests?: () => void })
      | undefined;
    if (!api?.clearRequestLogForTests) throw new Error("Mock Bridge API unavailable");
    api.clearRequestLogForTests();
  });

  await expect(dialog).toBeHidden({ timeout: 5_000 });
});

test("surfaces wire IPC and last-known status errors without unhandled rejections", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const api = window.ambientBridge as
      | (NonNullable<typeof window.ambientBridge> & { emitStatusChangedForTests?: () => void })
      | undefined;
    if (!api) throw new Error("Mock Bridge API unavailable");
    api.getWireCapture = async () => { throw new Error("Wire IPC unavailable"); };
    api.getStatus = async () => { throw new Error("Status IPC unavailable"); };
    // Safety poll is 15s; push a status-changed ping so the banner appears promptly.
    if (!api.emitStatusChangedForTests) throw new Error("Mock status ping unavailable");
    api.emitStatusChangedForTests();
  });

  await page.getByRole("button", { name: /Inspect Chat request req-1/ }).click();
  await expect(page.getByRole("dialog", { name: "Chat request" }).getByRole("alert")).toContainText("Wire IPC unavailable");
  await expect(page.getByRole("alert").filter({ hasText: "Showing the last known Bridge status" })).toBeVisible({ timeout: 5_000 });
});

type StatusRaceOutcome = "ready" | "signed_out" | "offline" | "error";
type StatusRaceWindow = typeof window & {
  statusRace: { calls: string[]; settle(index: number, outcome: StatusRaceOutcome): Promise<void> };
};

async function openStatusRace(page: Page) {
  await page.addInitScript(() => {
    let api: Window["ambientBridge"];
    Object.defineProperty(window, "ambientBridge", {
      configurable: true,
      get: () => api,
      set: (next: NonNullable<Window["ambientBridge"]>) => {
        api = next;
        const ready = next.getStatus();
        const calls: string[] = [];
        const pending: Array<{ resolve(status: BridgeStatus): void; reject(error: Error): void }> = [];
        const read = (method: string) => new Promise<BridgeStatus>((resolve, reject) => {
          calls.push(method);
          pending.push({ resolve, reject });
        });
        next.getStatus = () => read("status");
        next.retryReachability = () => read("reachability");
        (window as StatusRaceWindow).statusRace = {
          calls,
          async settle(index, outcome) {
            const request = pending[index];
            if (!request) throw new Error(`Missing status request ${index}`);
            const status = await ready;
            if (outcome === "error") request.reject(new Error(`Status failure ${index}`));
            else request.resolve(outcome === "signed_out" ? { ...status, account: { kind: "signed_out" } }
              : outcome === "offline" ? { ...status, connection: "offline", serverReachable: false,
                serverReachability: "unavailable", serverReachabilityReason: "offline",
                serverReachabilityMessage: "Controlled network unavailable" } : status);
          },
        };
      },
    });
  });
  await page.goto("/");
  const race = {
    settle: (index: number, outcome: StatusRaceOutcome) => page.evaluate(
      ([id, result]) => (window as StatusRaceWindow).statusRace.settle(id, result),
      [index, outcome] as const,
    ),
    push: () => page.evaluate(() => {
      const api = window.ambientBridge as NonNullable<Window["ambientBridge"]> & {
        emitStatusChangedForTests(): void;
      };
      api.emitStatusChangedForTests();
    }),
    reads: (calls: string[]) => expect.poll(
      () => page.evaluate(() => (window as StatusRaceWindow).statusRace?.calls),
    ).toEqual(calls),
  };
  await race.reads(["status"]);
  return race;
}

for (const outcome of ["signed_out", "error"] as const) {
  for (const order of ["older first", "newer first"] as const) {
    test(`settles foreground loading after background ${outcome}, ${order}`, async ({ page }) => {
      const race = await openStatusRace(page);
      const loading = page.getByRole("status").filter({ hasText: "Loading Bridge status" });
      await expect(loading).toBeVisible();
      await race.push();
      await race.reads(["status", "status"]);
      if (order === "older first") {
        await race.settle(0, "ready");
        await expect(loading).toBeVisible();
        await expect(page.getByTestId("bridge-window-shell")).toHaveCount(0);
      }
      await race.settle(1, outcome);
      if (order === "newer first") await race.settle(0, "error");
      await expect(loading).toHaveCount(0);
      const retry = page.getByRole("button", { name: outcome === "error" ? "Try again" : "Check status", exact: true });
      if (outcome === "error") {
        await expect(page.getByRole("alert")).toContainText("Status failure 1");
      } else {
        await expect(page.getByText("Sign in to Ambient Bridge", { exact: true })).toBeVisible();
      }
      await expect(page.getByText("Status failure 0", { exact: true })).toHaveCount(0);
      await expect(retry).toBeEnabled();
      await retry.click();
      await race.reads(["status", "status", "status"]);
      if (outcome === "error") await expect(loading).toBeVisible();
      else await expect(retry).toBeDisabled();
      await race.settle(2, "ready");
      await expect(page.getByRole("region", { name: "Requests", exact: true })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
    });
  }
}

for (const guard of ["signed_out", "offline"] as const) {
  test(`keeps a newer ${guard} manual check busy when stale background fails`, async ({ page }) => {
    const race = await openStatusRace(page);
    await race.settle(0, guard);
    const retry = page.getByRole("button", { name: guard === "offline" ? "Try again" : "Check status", exact: true });
    await expect(retry).toBeEnabled();
    await race.push();
    await race.reads(["status", "status"]);
    await expect(retry).toBeEnabled();
    await retry.click();
    await race.reads(["status", "status", guard === "offline" ? "reachability" : "status"]);
    await expect(retry).toBeDisabled();
    await race.settle(1, "error");
    await expect(retry).toBeDisabled();
    await race.settle(2, "ready");
    await expect(page.getByRole("region", { name: "Requests", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test("keeps background-only status recovery silent after the shell loads", async ({ page }) => {
  const race = await openStatusRace(page);
  await race.settle(0, "ready");
  const requests = page.getByRole("region", { name: "Requests", exact: true });
  await expect(requests).toBeVisible();
  await race.push();
  await race.reads(["status", "status"]);
  await expect(requests).toBeVisible();
  await race.settle(1, "error");
  const alert = page.getByRole("alert").filter({ hasText: "Showing the last known Bridge status" });
  await expect(alert).toContainText("Status failure 1");
  await expect(alert.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
  await race.push();
  await race.reads(["status", "status", "status"]);
  await expect(requests).toBeVisible();
  await expect(alert.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
  await race.settle(2, "ready");
  await expect(alert).toHaveCount(0);
  await expect(requests).toBeVisible();
});


test("shows provider billing failure details, time, and correlation ID", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    let api: Window["ambientBridge"];
    Object.defineProperty(window, "ambientBridge", {
      configurable: true,
      get: () => api,
      set: (next: NonNullable<Window["ambientBridge"]>) => {
        api = next;
        const read = next.getRequestLog.bind(next);
        next.getRequestLog = async () => {
          const status = await read();
          status.requests = status.requests.map(request => request.requestId === "req-3"
            ? { ...request, error: "AI processing is temporarily unavailable. Try again shortly; if this continues, contact Ambient support. (UPSTREAM_BILLING_UNAVAILABLE)" }
            : request);
          return status;
        };
      },
    });
  });
  await page.goto("/?bridgeMockModelDetails=1");
  await page.getByRole("button", { name: /Inspect Transcription request req-3/ }).click();
  const error = page.getByTestId("request-error");
  await expect(error).toContainText("UPSTREAM_BILLING_UNAVAILABLE");
  await expect(error).toContainText("contact Ambient support");
  await expect(error).toContainText(/Failed at \d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  await expect(error).toContainText("Request req-3");
  if (process.env.AMBIENT_BILLING_SCREENSHOT) {
    await page.screenshot({ path: process.env.AMBIENT_BILLING_SCREENSHOT, animations: "disabled" });
  }
});

for (const enabled of [false, true]) {
  test(`model details follow WorkOS flag: ${enabled}`, async ({ page }) => {
    await page.goto(`/?bridgeMockModelDetails=${enabled ? "1" : "0"}`);
    await expect(page.getByRole("region", { name: "Requests", exact: true })).toBeVisible();
    const model = page.getByText("gemma4-31b", { exact: true });
    if (enabled) await expect(model).toBeVisible();
    else await expect(model).toHaveCount(0);
  });
}
