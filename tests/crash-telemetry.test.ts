import { describe, expect, it } from "vitest";
import {
  bridgeErrorTelemetryBatch,
  bridgeTelemetryBatch,
  bridgeTelemetryEnabled,
  createBridgeErrorForwardLimiter,
} from "../electron/diagnostics/crash-telemetry.js";

describe("bridge crash telemetry", () => {
  it("builds a fatal bridge.main.error batch from an uncaught exception", () => {
    const error = new TypeError("boom");
    const batch = bridgeErrorTelemetryBatch({
      origin: "uncaughtException",
      error,
      appVersion: "0.2.0-test",
      platform: "darwin",
      nowMs: 1_780_842_000_000,
    }) as Record<string, unknown>;

    expect(batch.payloadVersion).toBe(1);
    expect(batch.sentAtMs).toBe(1_780_842_000_000);
    const events = batch.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventName: "bridge.main.error",
      severity: "fatal",
      component: "bridge-main",
      service: "bridge/electron-main",
      status: "failure",
      release: "0.2.0-test",
      properties: { origin: "uncaughtException" },
      exception: { type: "TypeError", message: "boom", handled: false },
    });
  });

  it("marks unhandled rejections as error severity and stringifies non-Error reasons", () => {
    const batch = bridgeErrorTelemetryBatch({
      origin: "unhandledRejection",
      error: "plain reason",
      appVersion: "0.2.0-test",
      platform: "linux",
    }) as Record<string, unknown>;

    const events = batch.events as Array<Record<string, unknown>>;
    expect(events[0]).toMatchObject({
      severity: "error",
      exception: { type: "Error", message: "plain reason", stack: null, handled: false },
    });
  });

  it("bounds oversized messages and stacks", () => {
    const error = new Error("m".repeat(5_000));
    error.stack = "s".repeat(20_000);
    const batch = bridgeErrorTelemetryBatch({
      origin: "uncaughtException",
      error,
      appVersion: "0.2.0-test",
      platform: "darwin",
    }) as Record<string, unknown>;

    const exception = (batch.events as Array<Record<string, unknown>>)[0].exception as Record<string, string>;
    expect(exception.message).toHaveLength(1_000);
    expect(exception.stack).toHaveLength(12_000);
  });

  it("is disabled only by an explicit AMBIENT_BRIDGE_TELEMETRY opt-out", () => {
    expect(bridgeTelemetryEnabled({})).toBe(true);
    expect(bridgeTelemetryEnabled({ AMBIENT_BRIDGE_TELEMETRY: "1" })).toBe(true);
    for (const value of ["0", "false", "off", "no", " OFF "]) {
      expect(bridgeTelemetryEnabled({ AMBIENT_BRIDGE_TELEMETRY: value })).toBe(false);
    }
  });

  it("builds launch and crash-report batches with the bridge service taxonomy", () => {
    const launch = bridgeTelemetryBatch({
      eventName: "bridge.main.appLaunched",
      severity: "info",
      status: "success",
      appVersion: "0.2.0-test",
      platform: "darwin",
      properties: { previousCrashPending: true, previousCrashOrigin: "uncaughtException" },
      nowMs: 1_780_842_000_000,
    }) as Record<string, unknown>;

    const events = launch.events as Array<Record<string, unknown>>;
    expect(events[0]).toMatchObject({
      eventName: "bridge.main.appLaunched",
      severity: "info",
      component: "bridge-main",
      service: "bridge/electron-main",
      status: "success",
      properties: { previousCrashPending: true, previousCrashOrigin: "uncaughtException" },
      exception: null,
    });
  });

  it("limits error forwarding to a bounded per-minute budget", () => {
    let now = 0;
    const allows = createBridgeErrorForwardLimiter(() => now);
    const firstWindow = Array.from({ length: 10 }, () => allows());
    expect(firstWindow.filter(Boolean)).toHaveLength(6);

    now += 61_000;
    expect(allows()).toBe(true);
  });
});
