import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../electron/diagnostics/audit.js";

describe("Bridge audit logging", () => {
  it("redacts sensitive inference and credential fields", () => {
    const audit = new MemoryAuditSink();

    audit.record("inference.test", {
      audio: "raw-audio",
      body: "encrypted-body",
      completion: "answer",
      key: "api-key",
      prompt: "question",
      requestId: "req_1",
      token: "session-token",
      transcript: "spoken words",
    });

    expect(audit.recent()[0]?.fields).toEqual({
      audio: "[redacted]",
      body: "[redacted]",
      completion: "[redacted]",
      key: "[redacted]",
      prompt: "[redacted]",
      requestId: "req_1",
      token: "[redacted]",
      transcript: "[redacted]",
    });
  });
});
