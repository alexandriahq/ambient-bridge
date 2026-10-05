// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ambientToast } from "@ambient/shared/notifications";
import { startBridgeUpdateNotifications } from "../src/lib/update-notifications";
import type { BridgeUpdateStatus } from "../src/lib/bridge-api";

describe("Bridge update notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(ambientToast, "custom").mockReturnValue("test-update-toast");
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(window, "ambientBridge");
  });

  test("mirrors update status without checking the feed or prompting", async () => {
    const onStatus = vi.fn();
    const checkForUpdates = vi.fn().mockResolvedValue(updateStatus({ downloaded: true, updateAvailable: true }));
    const installUpdate = vi.fn().mockResolvedValue(updateStatus({ downloaded: true }));
    const viewUpdateReleaseNotes = vi.fn().mockResolvedValue(true);
    const getUpdateStatus = vi.fn().mockResolvedValue(updateStatus({ downloaded: true, updateAvailable: true }));
    Object.defineProperty(window, "ambientBridge", {
      configurable: true,
      value: {
        getUpdateStatus,
        checkForUpdates,
        installUpdate,
        viewUpdateReleaseNotes,
        onUpdateStatusChanged: vi.fn(() => vi.fn()),
      },
    });

    const stop = startBridgeUpdateNotifications(onStatus);
    await getUpdateStatus.mock.results[0]?.value;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getUpdateStatus).toHaveBeenCalledOnce();
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ downloaded: true }));
    expect(ambientToast.custom).not.toHaveBeenCalled();
    expect(installUpdate).not.toHaveBeenCalled();
    expect(viewUpdateReleaseNotes).not.toHaveBeenCalled();
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
    releaseNotesUrl: "https://api.alexandria.so/changelog/apps/ambient-bridge/alpha/darwin/arm64",
    updateAvailable: false,
    ...patch,
  };
}
