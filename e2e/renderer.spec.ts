import { expect, test, type Page } from "@playwright/test";

const rendererErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  rendererErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
});

test.afterEach(async ({ page }) => {
  expect(rendererErrors.get(page) ?? []).toEqual([]);
});

test("shows an honest initial loading state before Bridge status is available", async ({ page }) => {
  await page.goto("/?bridgeMockStatusDelayMs=30000");
  await expect(page.getByRole("status").filter({ hasText: "Loading Bridge status" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Requests", exact: true })).toBeVisible();
});

test("shows the full request list and opens request inspection", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Ambient Bridge");
  await expect(page.getByRole("status", { name: /Bridge ready.*api\.alexandria\.so.*1 of 2 attested/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Traffic", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Activity", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Security", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Runtime", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Recent activity", exact: true })).toHaveCount(0);
  const windowShell = page.getByTestId("bridge-window-shell");
  await expect(windowShell).toHaveCSS("padding", "0px");
  await expect(windowShell).toHaveCSS("border-width", "0px");
  await expect(windowShell).toHaveCSS("border-radius", "0px");
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

test("keeps the centered toolbar status clear of controls in a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 600 });
  await page.goto("/");

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

test("opens and dismisses shared settings", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Mock User you@example.com", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(settings.getByText("Ambient Bridge", { exact: true })).toBeVisible();
  const closeSettings = settings.getByRole("button", { name: "Close settings" });
  await expect(closeSettings).toContainText("Close");
  await closeSettings.click();
  await expect(settings).toBeHidden();
});

test("renders update notifications with the shared compact card spacing", async ({ page }) => {
  await page.goto("/?bridgeMockUpdate=downloading");

  const toast = page.getByTestId("ambient-action-toast");
  await expect.poll(async () => {
    if (!await toast.isVisible()) return null;
    return toast.evaluate((element) => {
      const styles = window.getComputedStyle(element);
      const releaseNotes = Array.from(element.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Release notes");
      return {
        gap: styles.rowGap,
        padding: styles.padding,
        progressVisible: element.textContent?.includes("Downloading the update (60%).") ?? false,
        releaseNotesVisible: Boolean(releaseNotes && releaseNotes.getBoundingClientRect().height > 0),
        width: styles.width,
      };
    });
  }).toEqual({
    gap: "12px",
    padding: "14px",
    progressVisible: true,
    releaseNotesVisible: true,
    width: "360px",
  });
});

test("lists and installs experimental builds from feature-gated Dev settings", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Mock User you@example.com", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Dev", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Experimental builds" })).toBeVisible();
  await expect(page.getByText(/2 experimental builds available/)).toBeVisible();
  const buildSelector = page.getByRole("combobox", { name: "Build version" });
  const buildOptions = buildSelector.getByRole("option");
  await expect(buildOptions).toHaveCount(2);
  await buildSelector.selectOption({ index: 1 });
  await page.getByRole("button", { name: "Install selected build" }).click();
  await expect(page.getByRole("button", { name: "Downloading" })).toBeVisible();
});

test("hides Dev settings without the devtools feature flag", async ({ page }) => {
  await page.goto("/?bridgeMockDevtools=0");

  await page.getByRole("button", { name: "Mock User you@example.com", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Dev", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Experimental builds" })).toHaveCount(0);
});

test("surfaces experimental build listing failures inside Dev settings", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const api = window.ambientBridge;
    if (!api) throw new Error("Mock Bridge API unavailable");
    api.listExperimentalBuilds = async () => { throw new Error("Release service unavailable"); };
  });

  await page.getByRole("button", { name: "Mock User you@example.com", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Dev", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Release service unavailable");
  await expect(page.getByRole("button", { name: "Install selected build" })).toBeDisabled();
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

  await page.evaluate(async () => {
    const api = window.ambientBridge;
    if (!api) throw new Error("Mock Bridge API unavailable");
    const current = await api.getStatus();
    api.getStatus = async () => ({
      ...current,
      inference: {
        ...current.inference,
        activeRequests: 0,
        lastRequest: null,
        requests: [],
        wireCaptureRevision: current.inference.wireCaptureRevision + 1,
      },
    });
  });

  await expect(dialog).toBeHidden({ timeout: 5_000 });
});

test("surfaces wire IPC and last-known status errors without unhandled rejections", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const api = window.ambientBridge;
    if (!api) throw new Error("Mock Bridge API unavailable");
    api.getWireCapture = async () => { throw new Error("Wire IPC unavailable"); };
    api.getStatus = async () => { throw new Error("Status IPC unavailable"); };
  });

  await page.getByRole("button", { name: /Inspect Chat request req-1/ }).click();
  await expect(page.getByRole("dialog", { name: "Chat request" }).getByRole("alert")).toContainText("Wire IPC unavailable");
  await expect(page.getByRole("alert").filter({ hasText: "Showing the last known Bridge status" })).toBeVisible({ timeout: 5_000 });
});
