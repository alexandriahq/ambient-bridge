import { describe, expect, it } from "vitest";
import {
  NetworkRequestHistory,
  parseInferenceUsageMetrics,
  readEhbpResponseEvidence,
} from "../electron/inference/network-log.js";

describe("parseInferenceUsageMetrics", () => {
  it("parses the Tinfoil usage header", () => {
    expect(parseInferenceUsageMetrics("prompt=67,completion=42,total=109")).toEqual({
      completionTokens: 42,
      promptTokens: 67,
      totalTokens: 109,
    });
  });

  it("ignores ordering and surrounding whitespace", () => {
    expect(parseInferenceUsageMetrics(" total=10 , prompt=4 , completion=6 ")).toEqual({
      completionTokens: 6,
      promptTokens: 4,
      totalTokens: 10,
    });
  });

  it("returns null for missing fields or malformed input", () => {
    expect(parseInferenceUsageMetrics("prompt=1,total=1")).toBeNull();
    expect(parseInferenceUsageMetrics("prompt=abc,completion=1,total=1")).toBeNull();
    expect(parseInferenceUsageMetrics("")).toBeNull();
    expect(parseInferenceUsageMetrics(null)).toBeNull();
    expect(parseInferenceUsageMetrics(undefined)).toBeNull();
  });
});

describe("readEhbpResponseEvidence", () => {
  it("reads EHBP envelope artifacts from response headers", () => {
    const headers = new Headers({
      "content-type": "text/event-stream",
      "ehbp-response-nonce": "nonce_abc",
      "x-tinfoil-request-id": "tin_req_1",
      "x-tinfoil-usage-metrics": "prompt=3,completion=5,total=8",
    });

    expect(readEhbpResponseEvidence(headers)).toEqual({
      ehbpResponseNonce: "nonce_abc",
      tinfoilRequestId: "tin_req_1",
      usage: { completionTokens: 5, promptTokens: 3, totalTokens: 8 },
    });
  });

  it("degrades gracefully when envelope headers are absent", () => {
    expect(readEhbpResponseEvidence(new Headers())).toEqual({
      ehbpResponseNonce: null,
      tinfoilRequestId: null,
      usage: null,
    });
  });
});

describe("NetworkRequestHistory", () => {
  const start = (history: NetworkRequestHistory, requestId: string, startedAt = 1) =>
    history.start({
      feature: "inference.chatCompletions",
      model: "gpt",
      path: "/v1/chat/completions",
      requestId,
      startedAt,
    });

  it("keeps requests most-recent-first", () => {
    const history = new NetworkRequestHistory();
    start(history, "a", 1);
    start(history, "b", 2);
    expect(history.list().map((r) => r.requestId)).toEqual(["b", "a"]);
    expect(history.latest()?.requestId).toBe("b");
  });

  it("defaults a new request to pending attestation and EHBP encryption", () => {
    const history = new NetworkRequestHistory();
    const record = start(history, "a");
    expect(record.attestation).toBe("pending");
    expect(record.encryption).toBe("ehbp");
    expect(record.status).toBe("active");
    expect(record.usage).toBeNull();
  });

  it("re-starting the same request id de-duplicates and moves it to the front", () => {
    const history = new NetworkRequestHistory();
    start(history, "a", 1);
    start(history, "b", 2);
    start(history, "a", 3);
    expect(history.list().map((r) => r.requestId)).toEqual(["a", "b"]);
  });

  it("enforces the ring-buffer limit", () => {
    const history = new NetworkRequestHistory(2);
    start(history, "a", 1);
    start(history, "b", 2);
    start(history, "c", 3);
    expect(history.list().map((r) => r.requestId)).toEqual(["c", "b"]);
  });

  it("patches an existing record and snapshots on read", () => {
    const history = new NetworkRequestHistory();
    start(history, "a");
    history.patch("a", { attestation: "verified", status: "completed", statusCode: 200 });

    const snapshot = history.list()[0]!;
    expect(snapshot.attestation).toBe("verified");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.statusCode).toBe(200);

    // mutating the snapshot must not affect stored state
    snapshot.status = "failed";
    expect(history.latest()?.status).toBe("completed");
  });

  it("ignores patches for unknown request ids", () => {
    const history = new NetworkRequestHistory();
    start(history, "a");
    expect(history.patch("missing", { status: "failed" })).toBeNull();
    expect(history.latest()?.status).toBe("active");
  });
});
