import { describe, expect, it } from "vitest";
import {
  NetworkRequestHistory,
  parseInferenceUsageMetrics,
  readEhbpResponseEvidence,
  readEhbpUsageAfterBody,
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

  it("accepts live Tinfoil headers with model metadata and cached-token fields", () => {
    expect(parseInferenceUsageMetrics(
      "prompt=1935,completion=48,total=1983,cached_prompt_tokens=1856,uncached_prompt_tokens=79,model=gemma4-31b",
    )).toEqual({
      completionTokens: 48,
      promptTokens: 1935,
      totalTokens: 1983,
    });
  });

  it("accepts token-name aliases and derives a missing total", () => {
    expect(parseInferenceUsageMetrics("prompt_tokens=10;completion_tokens=5")).toEqual({
      completionTokens: 5,
      promptTokens: 10,
      totalTokens: 15,
    });
  });

  it("tolerates whitespace around equals", () => {
    expect(parseInferenceUsageMetrics("prompt = 1 , completion = 2 , total = 3")).toEqual({
      completionTokens: 2,
      promptTokens: 1,
      totalTokens: 3,
    });
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

  it("reads usage from response trailers after the body", async () => {
    const response = new Response(null, {
      headers: { "content-type": "text/event-stream" },
    });
    Object.defineProperty(response, "trailer", {
      value: Promise.resolve(new Headers({
        "x-tinfoil-usage-metrics": "prompt=5,completion=7,total=12,model=glm-5-2",
      })),
    });
    await expect(readEhbpUsageAfterBody(response)).resolves.toEqual({
      completionTokens: 7,
      promptTokens: 5,
      totalTokens: 12,
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
    expect(record.responseHeadersAt).toBeNull();
    expect(record.firstChunkAt).toBeNull();
  });

  it("records a plaintext OpenRouter hop as not attested", () => {
    const history = new NetworkRequestHistory();
    const record = history.start({
      attestation: "skipped",
      encryption: "none",
      feature: "inference.chatCompletions",
      model: "deepseek-v4-flash",
      path: "/v1/chat/completions",
      requestId: "or-1",
      startedAt: 1,
    });
    expect(record.attestation).toBe("skipped");
    expect(record.encryption).toBe("none");
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

    const snapshot = history.list(1)[0]!;
    expect(snapshot.attestation).toBe("verified");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.statusCode).toBe(200);

    // mutating the snapshot must not affect stored state
    snapshot.status = "failed";
    expect(history.latest()?.status).toBe("completed");
  });

  it.each([
    [undefined, ["c", "b", "a"]],
    [Number.NaN, ["c", "b", "a"]],
    [Infinity, ["c", "b", "a"]],
    [-1, ["c", "b", "a"]],
    [0, []],
    [1.9, ["c"]],
    [2, ["c", "b"]],
    [100, ["c", "b", "a"]],
  ])("preserves newest-first history for limit %s", (limit, ids) => {
    const history = new NetworkRequestHistory();
    start(history, "a", 1);
    start(history, "b", 2);
    start(history, "c", 3);
    expect(history.list(limit as number | undefined).map((record) => record.requestId)).toEqual(ids);
  });

  it("ignores patches for unknown request ids", () => {
    const history = new NetworkRequestHistory();
    start(history, "a");
    expect(history.patch("missing", { status: "failed" })).toBeNull();
    expect(history.latest()?.status).toBe("active");
  });

  it("isolates identical external request ids by an internal owner key", () => {
    const history = new NetworkRequestHistory();
    const input = {
      feature: "inference.responses",
      model: "gpt",
      path: "/v1/responses" as const,
      requestId: "same-id",
      startedAt: 1,
    };
    history.start(input, "client-a:same-id");
    history.start({ ...input, startedAt: 2 }, "client-b:same-id");

    history.patch("client-a:same-id", { status: "cancelled", completedAt: 3 });

    const records = history.list();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.requestId)).toEqual(["same-id", "same-id"]);
    expect(records.map((record) => record.status)).toEqual(["active", "cancelled"]);
    history.patchLatestByRequestId("same-id", { wireCaptured: true });
    expect(history.list().map((record) => record.wireCaptured)).toEqual([true, false]);
  });

  it("reads a completed row by owner key so the window can leave In flight", () => {
    const history = new NetworkRequestHistory();
    const input = {
      attestation: "skipped" as const,
      encryption: "none" as const,
      feature: "inference.chatCompletions",
      model: "gemma4-31b",
      path: "/v1/chat/completions" as const,
      requestId: "or-1",
      startedAt: 1,
    };
    history.start(input, "36:credential-or-1");
    history.patch("36:credential-or-1", { status: "completed", statusCode: 200, completedAt: 2 });

    expect(history.get("36:credential-or-1")).toMatchObject({
      requestId: "or-1",
      status: "completed",
      statusCode: 200,
      attestation: "skipped",
    });
    expect(history.get("or-1")?.status).toBe("completed");
  });
});
