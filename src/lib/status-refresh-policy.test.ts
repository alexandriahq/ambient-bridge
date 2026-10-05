import { describe, expect, it } from "vitest";
import {
  BRIDGE_STATUS_SAFETY_POLL_MS,
  shouldRunBridgeStatusSafetyPoll,
  statusRefreshSetsLoading,
} from "./status-refresh-policy.js";

describe("statusRefreshSetsLoading", () => {
  it("marks initial and manual refreshes as loading", () => {
    expect(statusRefreshSetsLoading()).toBe(true);
    expect(statusRefreshSetsLoading({ reachability: true })).toBe(true);
  });

  it("keeps background interval and push refreshes silent", () => {
    expect(statusRefreshSetsLoading({ background: true })).toBe(false);
    expect(statusRefreshSetsLoading({ background: true, reachability: true })).toBe(false);
  });
});

describe("shouldRunBridgeStatusSafetyPoll", () => {
  it("runs only while the Bridge window document is visible", () => {
    expect(shouldRunBridgeStatusSafetyPoll("visible")).toBe(true);
    expect(shouldRunBridgeStatusSafetyPoll("hidden")).toBe(false);
  });

  it("uses a slower safety interval than the previous 3s poll", () => {
    expect(BRIDGE_STATUS_SAFETY_POLL_MS).toBeGreaterThanOrEqual(10_000);
  });
});
