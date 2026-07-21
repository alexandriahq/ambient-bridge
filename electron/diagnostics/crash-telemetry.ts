import { randomUUID } from "node:crypto";
import type { JsonValue } from "../ipc-server/protocol.js";

export type BridgeCrashOrigin = "uncaughtException" | "unhandledRejection";

const MAX_MESSAGE_LENGTH = 1_000;
const MAX_STACK_LENGTH = 12_000;
const MAX_FORWARDS_PER_MINUTE = 6;

export type BridgeTelemetryEventName =
  | "bridge.main.appLaunched"
  | "bridge.main.crashReport"
  | "bridge.main.error";

export interface BridgeTelemetryBatchInput {
  readonly eventName: BridgeTelemetryEventName;
  readonly severity: "info" | "warning" | "error" | "fatal";
  readonly status: string;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly component?: string;
  readonly properties?: Record<string, unknown>;
  readonly exception?: {
    readonly type: string;
    readonly message: string;
    readonly stack: string | null;
    readonly handled: boolean;
  } | null;
  readonly nowMs?: number;
}

/**
 * Build a self-contained /analytics/telemetry batch for a Bridge-originated
 * event. Bridge has no local outbox: events are forwarded immediately
 * (best-effort) and otherwise only survive in the local audit log. Payloads are
 * metadata only — never request or response bodies.
 */
export function bridgeTelemetryBatch(input: BridgeTelemetryBatchInput): JsonValue {
  const nowMs = input.nowMs ?? Date.now();
  return {
    payloadVersion: 1,
    batchId: `tel_${randomUUID()}`,
    sentAtMs: nowMs,
    appVersion: input.appVersion,
    platform: input.platform,
    installId: null,
    events: [
      {
        eventName: input.eventName,
        severity: input.severity,
        component: input.component ?? "bridge-main",
        service: "bridge/electron-main",
        occurredAtMs: nowMs,
        durationMs: null,
        status: input.status,
        route: null,
        release: input.appVersion,
        properties: (input.properties ?? {}) as JsonValue,
        exception: input.exception ?? null,
      },
    ],
  } as JsonValue;
}

export interface BridgeErrorTelemetryInput {
  readonly origin: BridgeCrashOrigin;
  readonly error: unknown;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly nowMs?: number;
}

/** Batch for an unhandled Bridge process error: crash signature only. */
export function bridgeErrorTelemetryBatch(input: BridgeErrorTelemetryInput): JsonValue {
  return bridgeTelemetryBatch({
    eventName: "bridge.main.error",
    severity: input.origin === "uncaughtException" ? "fatal" : "error",
    status: "failure",
    appVersion: input.appVersion,
    platform: input.platform,
    properties: { origin: input.origin },
    exception: { ...exceptionSummary(input.error), handled: false },
    nowMs: input.nowMs,
  });
}

/**
 * True unless the user disabled Bridge-originated telemetry via
 * AMBIENT_BRIDGE_TELEMETRY=0/false/off. App-originated batches are unaffected —
 * the Ambient app checks its own telemetry setting before handing batches to
 * Bridge for forwarding.
 */
export function bridgeTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AMBIENT_BRIDGE_TELEMETRY?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

/**
 * Bounded forwarding budget so a crash loop (e.g. a rejection storm) audits
 * locally but cannot flood the server. Returns a function that answers "may I
 * forward one more event right now?".
 */
export function createBridgeErrorForwardLimiter(nowMs: () => number = Date.now): () => boolean {
  let windowStartedAtMs = 0;
  let windowCount = 0;
  return () => {
    const now = nowMs();
    if (now - windowStartedAtMs >= 60_000) {
      windowStartedAtMs = now;
      windowCount = 0;
    }
    windowCount += 1;
    return windowCount <= MAX_FORWARDS_PER_MINUTE;
  };
}

function exceptionSummary(error: unknown): { type: string; message: string; stack: string | null } {
  if (error instanceof Error) {
    return {
      type: error.name || "Error",
      message: error.message.slice(0, MAX_MESSAGE_LENGTH),
      stack: error.stack ? error.stack.slice(0, MAX_STACK_LENGTH) : null,
    };
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return {
      type: typeof record.name === "string" && record.name ? record.name : "Error",
      message: String(record.message ?? record.reason ?? error).slice(0, MAX_MESSAGE_LENGTH),
      stack: typeof record.stack === "string" ? record.stack.slice(0, MAX_STACK_LENGTH) : null,
    };
  }
  return { type: "Error", message: String(error).slice(0, MAX_MESSAGE_LENGTH), stack: null };
}
