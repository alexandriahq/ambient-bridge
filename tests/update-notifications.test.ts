// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ambientToast, showAmbientUpdateToast } from "@ambient/shared/notifications";
import { startBridgeUpdateNotifications } from "../src/lib/update-notifications";
import type { BridgeUpdateStatus } from "../src/lib/bridge-api";

vi.mock("@ambient/shared/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ambient/shared/notifications")>();
  return {
    ...actual,
    ambientToast: { dismiss: vi.fn() },
    showAmbientUpdateToast: vi.fn(),
  };
});

describe("Bridge update notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(showAmbientUpdateToast).mockClear();
    vi.mocked(ambientToast.dismiss).mockClear();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window, "ambientBridge");
  });

  test("checks Bridge updates on startup and prompts when an update is ready", async () => {
    const onStatus = vi.fn();
    const checkForUpdates = vi.fn().mockResolvedValue(updateStatus({ downloaded: true, updateAvailable: true }));
    const installUpdate = vi.fn().mockResolvedValue(updateStatus({ downloaded: true }));
    const viewUpdateReleaseNotes = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, "ambientBridge", {
      configurable: true,
      value: {
        getUpdateStatus: vi.fn().mockResolvedValue(updateStatus()),
        checkForUpdates,
        installUpdate,
        viewUpdateReleaseNotes,
        onUpdateStatusChanged: vi.fn(() => vi.fn()),
      },
    });

    const stop = startBridgeUpdateNotifications(onStatus);
    await vi.advanceTimersByTimeAsync(1_100);

    expect(checkForUpdates).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ downloaded: true }));
    expect(showAmbientUpdateToast).toHaveBeenCalledWith(
      expect.objectContaining({ downloaded: true, channel: "alpha" }),
      expect.objectContaining({ install: expect.any(Function), viewReleaseNotes: expect.any(Function) }),
      expect.objectContaining({ id: "ambient-bridge-update", productName: "Ambient Bridge" }),
    );

    const actions = vi.mocked(showAmbientUpdateToast).mock.calls.at(-1)?.[1];
    await actions?.install?.();
    await actions?.viewReleaseNotes?.();
    expect(installUpdate).toHaveBeenCalledOnce();
    expect(viewUpdateReleaseNotes).toHaveBeenCalledOnce();
    stop();
  });
});

function updateStatus(patch: Partial<BridgeUpdateStatus> = {}): BridgeUpdateStatus {
  return {
    channel: "alpha",
    checking: false,
    currentVersion: "0.1.0-alpha.2",
    downloaded: false,
    downloading: false,
    enabled: true,
    feedUrl: "https://api.alexandria.so/updates/apps/ambient-bridge/alpha/darwin/arm64/",
    latestVersion: "0.1.0-alpha.3",
    releaseNotesUrl: "https://api.alexandria.so/releases/apps/ambient-bridge/alpha/darwin/arm64",
    updateAvailable: false,
    ...patch,
  };
}
