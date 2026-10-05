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

function sealedRequest(requestId: string, body: Uint8Array<ArrayBuffer>, extraHeaders: Record<string, string> = {}): Request {
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

  it("classifies server admission 503 as a service circuit, not account exhaustion", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "SERVER_BUSY", message: "The inference gateway is at capacity. Retry shortly." },
    }), {
      status: 503,
      headers: {
        "retry-after": "2",
        "x-ambient-error-code": "SERVER_BUSY",
        "x-ambient-error-source": "ambient_server",
      },
    }));
    const h = host(fetchImpl);
    const tap = new WireTap();
    tap.install(h);

    await expect(h.fetch(sealedRequest("req_server_busy", new Uint8Array([1])))).rejects.toMatchObject({
      code: "UPSTREAM_ENVELOPE_UNAVAILABLE",
      httpStatus: 503,
      retryAfterSeconds: 2,
      source: "tinfoil_provider",
    });
    await expect(h.fetch(sealedRequest("req_server_busy_account", new Uint8Array([1]))))
      .rejects.not.toBeInstanceOf(BridgeInsufficientCreditError);
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
    expect(Buffer.from(body.base64, "base64").equals(Buffer.from(payload))).toBe(true);
  });

  it("encodes only the bytes of offset stream chunks across truncation boundaries", async () => {
    const backing = Uint8Array.from({ length: 270 }, (_, index) => (index * 47) % 256);
    const chunks = [backing.subarray(3, 91), backing.subarray(117, 202), backing.subarray(251, 270)];
    const expected = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
    for (const maxBytes of [0, 1, 87, 88, 89, expected.length, expected.length + 1]) {
      const stream = () => new ReadableStream<Uint8Array>({
        start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close(); },
      });
      const request = sealedRequest(`req_offsets_${maxBytes}`, new Uint8Array([1]));
      vi.spyOn(request, "clone").mockReturnValue({ body: stream() } as Request);
      const h = host(vi.fn(async () => new Response(stream(), { headers: { "ehbp-response-nonce": "nonce" } })));
      const tap = new WireTap({ maxRequestBytes: maxBytes, maxResponseBytes: maxBytes });
      tap.install(h);
      await h.fetch(request);
      await vi.waitFor(() => expect(tap.get(`req_offsets_${maxBytes}`)?.response).toBeTruthy());
      const capture = tap.get(`req_offsets_${maxBytes}`)!;
      for (const body of [capture.request.body, capture.response!.body]) {
        expect(body.base64).toBe(expected.subarray(0, maxBytes).toString("base64"));
        expect(body.capturedBytes).toBe(Math.min(maxBytes, expected.length));
        expect(body.truncated).toBe(maxBytes < expected.length);
      }
    }
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

  it.each(["request", "response"] as const)("releases a pending %s capture reader on clear without cancelling the original", async (side) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const request = side === "request"
      ? new Request("https://example.invalid/inference", {
        method: "POST", body: stream, duplex: "half",
        headers: { "x-ambient-request-id": "pending", "ehbp-encapsulated-key": "sealed" },
      } as RequestInit)
      : sealedRequest("pending", new Uint8Array([8]));
    const upstream = new Response(side === "response" ? stream : new Uint8Array([9]), {
      headers: { "ehbp-response-nonce": "nonce" },
    });
    const captured = { body: null as ReadableStream<Uint8Array> | null };
    if (side === "request") {
      const clone = request.clone.bind(request);
      vi.spyOn(request, "clone").mockImplementation(() => {
        const value = clone(); captured.body = value.body; return value;
      });
    } else {
      const clone = upstream.clone.bind(upstream);
      vi.spyOn(upstream, "clone").mockImplementation(() => {
        const value = clone(); captured.body = value.body; return value;
      });
    }
    const h = host(async () => upstream);
    const tap = new WireTap();
    tap.install(h);
    const response = await h.fetch(request);
    controller.enqueue(new Uint8Array([1, 2]));
    await flush();
    let closed = false;
    try {
      expect(captured.body).not.toBeNull();
      expect(captured.body!.locked).toBe(true);
      tap.clear();
      await vi.waitFor(() => expect(captured.body!.locked).toBe(false), { timeout: 250, interval: 5 });
      controller.enqueue(new Uint8Array([3, 4]));
      controller.close(); closed = true;
      const original = side === "request" ? request : response;
      expect([...new Uint8Array(await original.arrayBuffer())]).toEqual([1, 2, 3, 4]);
      await flush();
      expect(tap.get("pending")).toBeNull();
    } finally {
      if (!closed) controller.close();
      if (!request.bodyUsed) await request.arrayBuffer();
      if (!response.bodyUsed) await response.arrayBuffer();
    }
  });

  it("does not clone late response bodies after clear and captures the next generation", async () => {
    let resolve!: (response: Response) => void;
    const late = new Promise<Response>(done => { resolve = done; });
    const h = host(vi.fn().mockReturnValueOnce(late).mockImplementation(async () => new Response("new ciphertext")));
    const tap = new WireTap(); tap.install(h);
    const pending = h.fetch(sealedRequest("old", new Uint8Array([1])));
    tap.clear();
    const upstream = new Response("old ciphertext");
    const clone = vi.spyOn(upstream, "clone");
    resolve(upstream);
    expect(await (await pending).text()).toBe("old ciphertext");
    await flush();
    expect(clone).not.toHaveBeenCalled();
    expect(tap.get("old")).toBeNull();
    await h.fetch(sealedRequest("new", new Uint8Array([2])));
    await vi.waitFor(() => expect(tap.get("new")?.response).toBeTruthy());
    expect(tap.get("new")?.request.body.base64).toBe("Ag==");
  });

  it("retains plaintext control-error rejection after clear", async () => {
    let resolve!: (response: Response) => void;
    const h = host(() => new Promise<Response>(done => { resolve = done; }));
    const tap = new WireTap(); tap.install(h);
    const pending = h.fetch(sealedRequest("late-error", new Uint8Array([1])));
    const rejection = expect(pending).rejects.toBeInstanceOf(BridgeInsufficientCreditError);
    tap.clear();
    resolve(new Response("private upstream error", { status: 402, headers: {
      "x-ambient-error-code": "INSUFFICIENT_CREDIT", "x-ambient-error-source": "ambient_account",
    } }));
    await rejection;
    expect(tap.get("late-error")).toBeNull();
  });

  it("does not adopt old traffic when the fetch host clears synchronously", async () => {
    const tap = new WireTap();
    const h = host(async () => { tap.clear(); return new Response("ciphertext"); });
    tap.install(h);
    const response = await h.fetch(sealedRequest("reentrant", new Uint8Array([1])));
    expect(await response.text()).toBe("ciphertext");
    await flush();
    expect(tap.get("reentrant")).toBeNull();
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
