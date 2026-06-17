import type { AuditSink } from "./audit.js";

export type BridgeLogger = {
  info(name: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
  error(name: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
};

export function createAuditLogger(audit: AuditSink): BridgeLogger {
  return {
    error(name, fields = {}) {
      audit.record(name, { ...fields, level: "error" });
    },
    info(name, fields = {}) {
      audit.record(name, { ...fields, level: "info" });
    },
  };
}
