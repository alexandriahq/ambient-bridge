import { describe, expect, it, vi } from "vitest";
import { forwardHandoffFeedback } from "../electron/analytics/handoff-feedback.js";
import { MemoryAuditSink } from "../electron/diagnostics/audit.js";
import type { SignedInWorkOsSession } from "../electron/workos/session.js";

const PAYLOAD = { payloadVersion: 1, handoffId: "handoff_1", score: 4 };

describe("handoff feedback analytics forwarding", () => {
  it("posts plaintext JSON with the WorkOS session bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { ok: true, id: "hfb_1" }));
    const audit = new MemoryAuditSink();

    const result = await forwardHandoffFeedback("req_1", PAYLOAD, {
      audit,
      fetchImpl,
      onUnauthorized: vi.fn(),
      readSession: async () => session(),
      refreshSession: vi.fn(),
      serverBaseUrl: "https://api.example.test",
    });

    expect(result).toEqual({ ok: true, id: "hfb_1", error: null });
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.example.test/analytics/handoff-feedback");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(PAYLOAD));
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer session-token-1");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("never logs the request body or session token to the audit trail", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { ok: true, id: "hfb_1" }));
    const audit = new MemoryAuditSink();

    await forwardHandoffFeedback("req_1", PAYLOAD, {
      audit,
      fetchImpl,
      onUnauthorized: vi.fn(),
      readSession: async () => session(),
      refreshSession: vi.fn(),
      serverBaseUrl: "https://api.example.test",
    });

    const serialized = JSON.stringify(audit.recent());
    expect(serialized).not.toContain("session-token-1");
    expect(serialized).not.toContain("handoff_1");
    expect(audit.recent().map((event) => event.name)).toContain("analytics.handoff_feedback_complete");
  });

  it("rejects uploads while signed out without calling the server", async () => {
    const fetchImpl = vi.fn();

    const result = await forwardHandoffFeedback("req_1", PAYLOAD, {
      audit: new MemoryAuditSink(),
      fetchImpl,
      onUnauthorized: vi.fn(),
      readSession: async () => ({ kind: "signed_out" }),
      refreshSession: vi.fn(),
      serverBaseUrl: "https://api.example.test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Sign in to Ambient Bridge");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes an expiring session before uploading", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { ok: true, id: "hfb_1" }));
    const expiring = session({ expiresAt: Math.floor(Date.now() / 1000) - 10 });
    const refreshSession = vi.fn().mockResolvedValue(session({ sessionToken: "session-token-2" }));

    const result = await forwardHandoffFeedback("req_1", PAYLOAD, {
      audit: new MemoryAuditSink(),
      fetchImpl,
      onUnauthorized: vi.fn(),
      readSession: async () => expiring,
      refreshSession,
      serverBaseUrl: "https://api.example.test",
    });

    expect(result.ok).toBe(true);
    expect(refreshSession).toHaveBeenCalledWith(expiring);
    const [, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer session-token-2");
  });

  it("clears the stored session on a 401 and reports the server error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "Ambient session validation failed" }));
    const onUnauthorized = vi.fn();
    const requestSession = session();

    const result = await forwardHandoffFeedback("req_1", PAYLOAD, {
      audit: new MemoryAuditSink(),
      fetchImpl,
      onUnauthorized,
      readSession: async () => requestSession,
      refreshSession: vi.fn(),
      serverBaseUrl: "https://api.example.test",
    });

    expect(result).toEqual({ ok: false, id: null, error: "Ambient session validation failed" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith(
      "analytics handoff feedback request returned 401",
      requestSession,
    );
  });

  it("resolves with ok=false when the network request fails", async () => {
    const result = await forwardHandoffFeedback("req_1", PAYLOAD, {
      audit: new MemoryAuditSink(),
      fetchImpl: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
      onUnauthorized: vi.fn(),
      readSession: async () => session(),
      refreshSession: vi.fn(),
      serverBaseUrl: "https://api.example.test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("bounds a stalled analytics upload", async () => {
    const result = await forwardHandoffFeedback("req_1", PAYLOAD, {
      audit: new MemoryAuditSink(),
      fetchImpl: abortAwareHangingFetch(),
      onUnauthorized: vi.fn(),
      readSession: async () => session(),
      refreshSession: vi.fn(),
      serverBaseUrl: "https://api.example.test",
      timeoutMs: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("keeps the timeout active while consuming the analytics response body", async () => {
    const result = await forwardHandoffFeedback("req_1", PAYLOAD, {
      audit: new MemoryAuditSink(),
      fetchImpl: responseWithStalledBody(),
      onUnauthorized: vi.fn(),
      readSession: async () => session(),
      refreshSession: vi.fn(),
      serverBaseUrl: "https://api.example.test",
      timeoutMs: 5,
    });

    expect(result).toEqual({
      ok: false,
      id: null,
      error: "Ambient analytics request timed out after 5 ms.",
    });
  });

  it("rejects non-object payloads before contacting the server", async () => {
    const fetchImpl = vi.fn();

    const result = await forwardHandoffFeedback("req_1", undefined, {
      audit: new MemoryAuditSink(),
      fetchImpl,
      onUnauthorized: vi.fn(),
      readSession: async () => session(),
      refreshSession: vi.fn(),
      serverBaseUrl: "https://api.example.test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("JSON object");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function session(overrides: Partial<SignedInWorkOsSession> = {}): SignedInWorkOsSession {
  return {
    kind: "signed_in",
    sessionToken: "session-token-1",
    expiresAt: Math.floor(Date.now() / 1000) + 60 * 60,
    user: { id: "user_1", email: "user@example.test", name: "User" },
    email: "user@example.test",
    organizationId: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function abortAwareHangingFetch(): typeof fetch {
  return vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })) as unknown as typeof fetch;
}

function responseWithStalledBody(): typeof fetch {
  return vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
    const signal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }) as unknown as typeof fetch;
}
