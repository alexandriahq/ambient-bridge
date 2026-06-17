import { describe, expect, it, vi } from "vitest";
import { WireTap, type FetchHost } from "../electron/inference/wire-tap.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function host(fetchImpl: FetchHost["fetch"]): FetchHost {
  return { fetch: fetchImpl };
}

function sealedRequest(requestId: string, body: Uint8Array, extraHeaders: Record<string, string> = {}): Request {
  return new Request("https://api.alexandria.so/v1/chat/completions", {
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
    expect(capture!.request.url).toBe("https://api.alexandria.so/v1/chat/completions");
    expect(capture!.request.body.base64).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(capture!.response?.status).toBe(200);
    expect(capture!.response?.body.base64).toBe(Buffer.from([9, 8, 7, 6]).toString("base64"));
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

    await h.fetch(new Request("https://api.alexandria.so/healthz", {
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

    const req = new Request("https://api.alexandria.so/v1/responses", {
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
