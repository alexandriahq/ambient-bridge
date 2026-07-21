import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrashRing } from "@ambient/shared/observability";
import { FileAuditSink, RingAuditSink, AUDIT_LOG_ROTATED_SUFFIX } from "../electron/diagnostics/audit.js";
import { bridgeComponentForAuditEvent, BRIDGE_LOG_COMPONENTS } from "../electron/diagnostics/logging.js";
import { createBridgeCrashReportStore } from "../electron/diagnostics/crash-report.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-observability-"));
  tempDirs.push(dir);
  return dir;
}

describe("audit event component mapping", () => {
  it("maps audit prefixes onto the closed component taxonomy", () => {
    expect(bridgeComponentForAuditEvent("auth.login_start")).toBe(BRIDGE_LOG_COMPONENTS.auth);
    expect(bridgeComponentForAuditEvent("inference.forward_start")).toBe(BRIDGE_LOG_COMPONENTS.inference);
    expect(bridgeComponentForAuditEvent("pairing.approve")).toBe(BRIDGE_LOG_COMPONENTS.pairing);
    expect(bridgeComponentForAuditEvent("process.uncaught_exception")).toBe(BRIDGE_LOG_COMPONENTS.bridgeMain);
    expect(bridgeComponentForAuditEvent("crash.report_declined")).toBe(BRIDGE_LOG_COMPONENTS.diagnostics);
    expect(bridgeComponentForAuditEvent("something.else")).toBe(BRIDGE_LOG_COMPONENTS.bridgeMain);
  });
});

describe("ring audit sink", () => {
  it("mirrors audit events into the crash ring as structured records", () => {
    const ring = new CrashRing();
    let now = 1_000;
    const sink = new RingAuditSink(ring, () => now);

    sink.record("auth.login_start", {});
    now = 2_000;
    sink.record("inference.forward_failed", { level: "error", token: "secret-token" });

    const summary = ring.summary(2_500);
    expect(summary.recordCount).toBe(2);
    expect(summary.levelCounts).toEqual({ INFO: 1, ERROR: 1 });
    expect(summary.componentCounts[BRIDGE_LOG_COMPONENTS.auth]).toBe(1);
    expect(summary.recentIssues[0].message).toBe("inference.forward_failed");

    const snapshot = ring.snapshot(2_500);
    expect(snapshot.text).toContain('"service":"bridge/electron-main"');
    // Sensitive audit fields stay redacted inside the ring lines too.
    expect(snapshot.text).not.toContain("secret-token");
  });
});

describe("file audit sink rotation", () => {
  it("rotates the audit log once it would exceed the size cap", async () => {
    const dir = tempDir();
    const auditPath = path.join(dir, "bridge-audit.jsonl");
    writeFileSync(auditPath, "x".repeat(200), "utf8");

    const sink = new FileAuditSink(auditPath, 100);
    sink.record("auth.login_start", {});
    await sink.flush();

    const rotated = readFileSync(`${auditPath}${AUDIT_LOG_ROTATED_SUFFIX}`, "utf8");
    expect(rotated).toBe("x".repeat(200));
    expect(readFileSync(auditPath, "utf8")).toContain("auth.login_start");
  });
});

describe("bridge crash report store", () => {
  it("writes a marker + window snapshot and lists it pending, newest first", () => {
    const ring = new CrashRing();
    ring.append({
      atMs: 900,
      level: "ERROR",
      component: "bridge-inference",
      message: "inference.forward_failed",
      line: '{"message":"inference.forward_failed"}\n',
    });
    const store = createBridgeCrashReportStore({
      dir: path.join(tempDir(), "crashes"),
      window: (nowMs) => ({ text: ring.snapshot(nowMs).text, summary: ring.summary(nowMs) }),
    });

    const marker = store.writeSnapshotSync({
      origin: "uncaughtException",
      error: new TypeError("boom"),
      appVersion: "0.2.0-test",
      platform: "darwin",
      nowMs: 1_000,
    });

    expect(marker).not.toBeNull();
    expect(marker?.origin).toBe("uncaughtException");
    expect(marker?.exception.type).toBe("TypeError");
    expect(marker?.windowSummary.recordCount).toBe(1);
    expect(readFileSync(marker!.windowFile, "utf8")).toContain("inference.forward_failed");

    const pending = store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(marker?.id);

    store.delete(marker!.id);
    expect(store.listPending()).toHaveLength(0);
  });
});
