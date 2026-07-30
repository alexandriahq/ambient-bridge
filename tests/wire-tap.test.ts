import { describe, expect, it, vi } from "vitest";
import { WireTap, type FetchHost } from "../electron/inference/wire-tap.js";
import {
  BridgeInferenceServiceError,
  BridgeInsufficientCreditError,
} from "../electron/inference/errors.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function host(fetchImpl: FetchHost["fetch"]): FetchHost {
  return { fetch: fetchImpl };
}

function sealedRequest(requestId: string, body: Uint8Array, extraHeaders: Record<string, string> = {}): Request {
  return new Request("https://ambientserver-staging.up.railway.app/v1/chat/completions", {
    body,
    headers: {
      "authorization": "Bearer super-secret-session-token",
      "content-type": "application/json",
      "ehbp-encapsulated-key": "7ff4f43339fdc5dacf1b1f22cdfc",
      "x-ambient-request-id": requestId,
      ...extraHeaders,
    },
    method: "POST",
  });
}

describe("WireTap", () => {
  it("captures the sealed request and encrypted response for EHBP traffic", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array([9, 8, 7, 6]), {
        headers: { "ehbp-response-nonce": "nonce_1", "x-tinfoil-request-id": "tin_1" },
        status: 200,
      }));
    const h = host(fetchImpl);
    const tap = new WireTap();
    tap.install(h);

    const response = await h.fetch(sealedRequest("req_1", new Uint8Array([1, 2, 3, 4])));
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await flush();

    const capture = tap.get("req_1");
    expect(capture).not.toBeNull();
    expect(capture!.request.method).toBe("POST");
    expect(capture!.request.url).toBe("https://ambientserver-staging.up.railway.app/v1/chat/completions");
    expect(capture!.request.body.base64).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(capture!.response?.status).toBe(200);
    expect(capture!.response?.body.base64).toBe(Buffer.from([9, 8, 7, 6]).toString("base64"));
  });

  it("classifies a legacy plain provider 402 without retaining its unverified body", async () => {
    const fetchImpl = vi.fn(async () => new Response("private provider billing detail", { status: 402 }));
    const h = host(fetchImpl);
    const tap = new WireTap();
    tap.install(h);

    await expect(h.fetch(sealedRequest("req_provider_402", new Uint8Array([1])))).rejects.toMatchObject({
      code: "UPSTREAM_BILLING_UNAVAILABLE",
      httpStatus: 402,
    });
    await expect(h.fetch(sealedRequest("req_provider_402_second", new Uint8Array([1]))))
      .rejects.toBeInstanceOf(BridgeInferenceServiceError);
    const capture = tap.get("req_provider_402");
    expect(capture?.response).toMatchObject({
      status: 402,
      body: { base64: "", capturedBytes: 0 },
    });
    expect(JSON.stringify(capture)).not.toContain("private provider billing detail");
  });

  it("trusts account exhaustion only with the server-authenticated error source", async () => {
    const fetchImpl = vi.fn(async () => new Response("account body", {
      status: 402,
      headers: {
        "x-ambient-error-code": "INSUFFICIENT_CREDIT",
        "x-ambient-error-source": "ambient_account",
      },
    }));
    const h = host(fetchImpl);
    const tap = new WireTap();
    tap.install(h);

    await expect(h.fetch(sealedRequest("req_account_402", new Uint8Array([1]))))
      .rejects.toBeInstanceOf(BridgeInsufficientCreditError);
    expect(JSON.stringify(tap.get("req_account_402"))).not.toContain("account body");
  });

  it("preserves sanitized upstream-envelope semantics instead of a missing-nonce error", async () => {
    const fetchImpl = vi.fn(async () => new Response("private rate limit detail", {
      status: 503,
      headers: {
        "retry-after": "120",
        "x-ambient-error-code": "UPSTREAM_ENVELOPE_UNAVAILABLE",
        "x-ambient-error-source": "tinfoil_provider",
      },
    }));
    const h = host(fetchImpl);
    const tap = new WireTap();
    tap.install(h);

    await expect(h.fetch(sealedRequest("req_provider_503", new Uint8Array([1])))).rejects.toMatchObject({
      code: "UPSTREAM_ENVELOPE_UNAVAILABLE",
      httpStatus: 503,
      retryAfterSeconds: 120,
    });
    expect(JSON.stringify(tap.get("req_provider_503"))).not.toContain("private rate limit detail");
  });

  it("redacts the session token from captured headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const h = host(fetchImpl);
    const tap = new WireTap();
    tap.install(h);

    await h.fetch(sealedRequest("req_redact", new Uint8Array([1])));
    await flush();

    const headers = tap.get("req_redact")!.request.headers;
    expect(headers.find((header) => header.name === "authorization")?.value).toBe("[redacted]");
    expect(headers.find((header) => header.name === "ehbp-encapsulated-key")?.value).toBe(
      "7ff4f43339fdc5dacf1b1f22cdfc",
    );
  });

  it("passes through and ignores non-EHBP requests", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const h = host(fetchImpl);
    const tap = new WireTap();
    tap.install(h);

    await h.fetch(new Request("https://ambientserver-staging.up.railway.app/healthz", {
      headers: { "x-ambient-request-id": "req_health" },
    }));
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(tap.get("req_health")).toBeNull();
  });

  it("does not capture sealed requests without a request id", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const h = host(fetchImpl);
    const tap = new WireTap();
    tap.install(h);

    const req = new Request("https://ambientserver-staging.up.railway.app/v1/responses", {
      body: new Uint8Array([1]),
      headers: { "ehbp-encapsulated-key": "key" },
      method: "POST",
    });
    await h.fetch(req);
    await flush();

    expect(tap.get("")).toBeNull();
  });

  it("caps captured bytes and flags truncation", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const h = host(fetchImpl);
    const tap = new WireTap({ maxBytes: 16 });
    tap.install(h);

    await h.fetch(sealedRequest("req_big", new Uint8Array(100).fill(7)));
    await flush();

    const body = tap.get("req_big")!.request.body;
    expect(body.capturedBytes).toBe(16);
    expect(body.truncated).toBe(true);
  });

  it("retains complete production-sized request ciphertext within the 8 MiB bound", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const h = host(fetchImpl);
    const tap = new WireTap();
    tap.install(h);
    const payload = new Uint8Array(6 * 1024 * 1024).fill(7);

    await h.fetch(sealedRequest("req_complete", payload));
    await flush();

    const body = tap.get("req_complete")!.request.body;
    expect(body.capturedBytes).toBe(payload.byteLength);
    expect(body.byteLength).toBe(payload.byteLength);
    expect(body.truncated).toBe(false);
  });

  it("keeps encrypted response previews bounded at 16 KiB", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(20 * 1024).fill(9)));
    const h = host(fetchImpl);
    const tap = new WireTap();
    tap.install(h);

    await h.fetch(sealedRequest("req_response_preview", new Uint8Array([1])));
    await flush();

    expect(tap.get("req_response_preview")!.response?.body).toMatchObject({
      capturedBytes: 16 * 1024,
      truncated: true,
    });
  });

  it("retains a fast encrypted response when request capture storage finishes later", async () => {
    let releaseRequestBody!: () => void;
    const requestBody = new ReadableStream<Uint8Array>({
      start(controller) {
        releaseRequestBody = () => {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        };
      },
    });
    const request = new Request("https://ambientserver-staging.up.railway.app/v1/responses", {
      body: requestBody,
      duplex: "half",
      headers: {
        "ehbp-encapsulated-key": "key",
        "x-ambient-request-id": "req_response_race",
      },
      method: "POST",
    } as RequestInit & { duplex: "half" });
    const h = host(vi.fn(async () => new Response(new Uint8Array([9, 8, 7]))));
    const tap = new WireTap();
    tap.install(h);

    await h.fetch(request);
    expect(tap.get("req_response_race")).toBeNull();
    releaseRequestBody();
    await flush();

    expect(tap.get("req_response_race")?.response?.body.base64).toBe(
      Buffer.from([9, 8, 7]).toString("base64"),
    );
  });

  it("does not mark an exact-cap body truncated after observing EOF", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const h = host(fetchImpl);
    const tap = new WireTap({ maxBytes: 16 });
    tap.install(h);

    await h.fetch(sealedRequest("req_exact", new Uint8Array(16).fill(4)));
    await flush();

    expect(tap.get("req_exact")!.request.body).toMatchObject({
      byteLength: 16,
      capturedBytes: 16,
      truncated: false,
    });
  });

  it("evicts oldest captures when the aggregate byte budget is reached", async () => {
    const fetchImpl = vi.fn(async () => new Response(null));
    const h = host(fetchImpl);
    const onEvict = vi.fn();
    const tap = new WireTap({ maxBytes: 16, maxTotalBytes: 5, onEvict });
    tap.install(h);

    await h.fetch(sealedRequest("req_budget_a", new Uint8Array([1, 2, 3])));
    await h.fetch(sealedRequest("req_budget_b", new Uint8Array([4, 5, 6])));
    await flush();

    expect(tap.get("req_budget_a")).toBeNull();
    expect(tap.get("req_budget_b")).not.toBeNull();
    expect(onEvict).toHaveBeenCalledWith("req_budget_a");
  });

  it("clears retained ciphertext and rejects late capture work across account boundaries", async () => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const h = host(vi.fn(() => response));
    const tap = new WireTap();
    tap.install(h);

    const pending = h.fetch(sealedRequest("req_old_account", new Uint8Array([1, 2, 3])));
    tap.clear();
    resolveResponse(new Response(new Uint8Array([4, 5, 6])));
    await pending;
    await flush();

    expect(tap.get("req_old_account")).toBeNull();
  });

  it("evicts old captures beyond the retention limit", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const h = host(fetchImpl);
    const tap = new WireTap({ limit: 2 });
    tap.install(h);

    await h.fetch(sealedRequest("req_a", new Uint8Array([1])));
    await h.fetch(sealedRequest("req_b", new Uint8Array([2])));
    await h.fetch(sealedRequest("req_c", new Uint8Array([3])));
    await flush();

    expect(tap.get("req_a")).toBeNull();
    expect(tap.get("req_b")).not.toBeNull();
    expect(tap.get("req_c")).not.toBeNull();
  });
});
