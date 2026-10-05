import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { threadId } from "node:worker_threads";
import type { CrashRing, StructuredLogLevel, StructuredLogRecord } from "@ambient/shared/observability";
import {
  bridgeComponentForAuditEvent,
  bridgeServiceForComponent,
} from "./logging.js";

export type AuditEvent = {
  name: string;
  at: number;
  fields: Record<string, string | number | boolean | null | undefined>;
};

export type AuditSink = {
  record(name: string, fields?: AuditEvent["fields"]): void;
  recent(): AuditEvent[];
  /** Waits for durable sinks to finish queued writes during graceful shutdown. */
  flush?(): Promise<void>;
};

const REDACTED_FIELD_PATTERN = /(body|prompt|completion|audio|transcript|secret|token|key|password)/i;
const MAX_AUDIT_FIELD_STRING_LENGTH = 512;

export class MemoryAuditSink implements AuditSink {
  private readonly events: AuditEvent[] = [];

  constructor(private readonly limit = 200) {}

  record(name: string, fields: AuditEvent["fields"] = {}): void {
    this.events.push({
      at: Date.now(),
      fields: sanitizeFields(fields),
      name,
    });
    if (this.events.length > this.limit) {
      this.events.shift();
    }
  }

  recent(): AuditEvent[] {
    return [...this.events];
  }
}

// The audit log is rotated once (to `<path>.1`) when it would exceed this cap,
// so local diagnostics use at most ~2x this much disk — same policy as the
// Ambient app's ambient.jsonl.
const AUDIT_LOG_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const AUDIT_LOG_ROTATED_SUFFIX = ".1";

export class FileAuditSink implements AuditSink {
  private pending: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(
    private readonly path: string,
    private readonly maxFileBytes = AUDIT_LOG_MAX_FILE_BYTES,
  ) {}

  record(name: string, fields: AuditEvent["fields"] = {}): void {
    const record = structuredAuditRecord(name, fields, Date.now());
    this.pending = this.pending
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const line = `${JSON.stringify(record)}\n`;
        await this.rotateIfNeeded(Buffer.byteLength(line, "utf8"));
        await appendFile(this.path, line, { mode: 0o600 });
      })
      .catch((error) => {
        if (!this.warned) {
          this.warned = true;
          console.error("[bridge] audit log write failed", error);
        }
      });
  }

  recent(): AuditEvent[] {
    return [];
  }

  flush(): Promise<void> {
    return this.pending;
  }

  /** Move the live log aside (replacing any previous rotation) at the size cap. */
  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    try {
      const { size } = await stat(this.path);
      if (size + incomingBytes <= this.maxFileBytes) return;
      const rotatedPath = `${this.path}${AUDIT_LOG_ROTATED_SUFFIX}`;
      await rm(rotatedPath, { force: true });
      await rename(this.path, rotatedPath);
    } catch {
      // Missing file (nothing to rotate) or a failed rename — keep appending.
    }
  }
}

/**
 * Mirrors every audit event into the shared crash ring as a structured record
 * (service + component from the Bridge taxonomy), so crash snapshots carry the
 * last ~30s of Bridge activity the same way the Ambient app's do.
 */
export class RingAuditSink implements AuditSink {
  constructor(
    private readonly ring: CrashRing,
    private readonly nowMs: () => number = Date.now,
  ) {}

  record(name: string, fields: AuditEvent["fields"] = {}): void {
    try {
      const atMs = this.nowMs();
      const record = structuredAuditRecord(name, fields, atMs);
      this.ring.append({
        atMs,
        level: record.level,
        component: record.component,
        message: record.message,
        line: `${JSON.stringify(record)}\n`,
      });
    } catch {
      // The crash window is strictly best-effort and must never disrupt auditing.
    }
  }

  recent(): AuditEvent[] {
    return [];
  }
}

export class CompositeAuditSink implements AuditSink {
  constructor(private readonly sinks: readonly AuditSink[]) {}

  record(name: string, fields: AuditEvent["fields"] = {}): void {
    for (const sink of this.sinks) {
      sink.record(name, fields);
    }
  }

  recent(): AuditEvent[] {
    return this.sinks[0]?.recent() ?? [];
  }

  async flush(): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.flush?.() ?? Promise.resolve()));
  }
}

export function sanitizeFields(fields: AuditEvent["fields"]): AuditEvent["fields"] {
  const sanitized: AuditEvent["fields"] = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_FIELD_PATTERN.test(key)) {
      sanitized[key] = "[redacted]";
    } else {
      sanitized[key] = typeof value === "string" ? value.slice(0, MAX_AUDIT_FIELD_STRING_LENGTH) : value;
    }
  }
  return sanitized;
}

function structuredAuditRecord(
  name: string,
  fields: AuditEvent["fields"],
  atMs: number,
): StructuredLogRecord<AuditEvent["fields"]> {
  const annotations = sanitizeFields(fields);
  const component = bridgeComponentForAuditEvent(name);
  return {
    ts: new Date(atMs).toISOString(),
    level: auditLevel(annotations.level),
    service: bridgeServiceForComponent(component),
    component,
    pid: process.pid,
    threadId,
    processType: "bridge-main",
    message: name,
    annotations,
  };
}

function auditLevel(value: unknown): StructuredLogLevel {
  if (typeof value !== "string") return "INFO";
  const normalized = value.toUpperCase();
  return normalized === "DEBUG" || normalized === "INFO" || normalized === "WARN"
    || normalized === "ERROR" || normalized === "FATAL"
    ? normalized
    : "INFO";
}
