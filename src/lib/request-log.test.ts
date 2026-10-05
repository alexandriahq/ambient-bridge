import { describe, expect, it } from "vitest";
import type { BridgeInferenceRequestStatus } from "./bridge-api";
import { applyRequestLogPatch, requestLogFromSnapshot } from "./request-log.js";

function row(
  requestId: string,
  patch: Partial<BridgeInferenceRequestStatus> = {},
): BridgeInferenceRequestStatus {
  return {
    attestation: "verified",
    completedAt: 2,
    ehbpResponseNonce: null,
    encryption: "ehbp",
    error: null,
    feature: "inference.chatCompletions",
    model: "gpt",
    path: "/v1/chat/completions",
    requestBytes: 12,
    requestId,
    startedAt: 1,
    status: "completed",
    statusCode: 200,
    tinfoilRequestId: null,
    usage: null,
    wireCaptured: false,
    traceId: null,
    responseHeadersAt: null,
    firstChunkAt: null,
    ...patch,
  };
}

describe("applyRequestLogPatch", () => {
  it("hydrates from a snapshot without requiring a later full replace", () => {
    const snapshot = { revision: 1, requests: [row("a"), row("b")] };
    expect(requestLogFromSnapshot(snapshot).map((r) => r.requestId)).toEqual(["a", "b"]);
  });

  it("upserts a new row at the front and keeps older rows", () => {
    const current = [row("a"), row("b")];
    const next = applyRequestLogPatch(current, {
      revision: 2,
      upserts: [row("c", { status: "active", completedAt: null })],
    });
    expect(next.map((r) => r.requestId)).toEqual(["c", "a", "b"]);
    expect(next[1]).toBe(current[0]);
    expect(next[2]).toBe(current[1]);
  });

  it("updates one row in place and preserves referential identity for unchanged rows", () => {
    const current = [row("a"), row("b"), row("c")];
    const updated = row("b", { status: "failed", statusCode: 500, error: "boom" });
    const next = applyRequestLogPatch(current, { revision: 3, upserts: [updated] });
    expect(next.map((r) => r.requestId)).toEqual(["b", "a", "c"]);
    expect(next[0]).toEqual(updated);
    expect(next[1]).toBe(current[0]);
    expect(next[2]).toBe(current[2]);
  });

  it("removes rows and respects the retention limit", () => {
    const current = [row("a"), row("b"), row("c"), row("d")];
    const next = applyRequestLogPatch(
      current,
      { revision: 4, upserts: [row("e")], removeIds: ["b"] },
      3,
    );
    expect(next.map((r) => r.requestId)).toEqual(["e", "a", "c"]);
  });

  it("keeps the same object when an upsert is byte-identical", () => {
    const current = [row("a"), row("b")];
    const next = applyRequestLogPatch(current, { revision: 5, upserts: [row("a")] });
    expect(next[0]).toBe(current[0]);
    expect(next[1]).toBe(current[1]);
  });

  it("resets the list before applying upserts", () => {
    const current = [row("a"), row("b")];
    const next = applyRequestLogPatch(current, {
      revision: 6,
      reset: true,
      upserts: [row("z")],
    });
    expect(next.map((r) => r.requestId)).toEqual(["z"]);
  });
});
