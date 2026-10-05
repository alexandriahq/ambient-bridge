import { describe, expect, it, vi } from "vitest";
import { forwardSupportFeedback } from "../electron/analytics/support-feedback.js";
import { MemoryAuditSink } from "../electron/diagnostics/audit.js";
import type { SignedInWorkOsSession } from "../electron/workos/session.js";

const PAYLOAD = { message: "Capture stopped after the update", client: { appVersion: "0.9.0", platform: "darwin" } };

function options(overrides: Partial<Parameters<typeof forwardSupportFeedback>[2]> = {}) {
  return {
    audit: new MemoryAuditSink(),
    onUnauthorized: vi.fn().mockResolvedValue(true),
    readSession: async () => session(),
    refreshSession: vi.fn(),
    serverBaseUrl: "https://api.example.test",
    ...overrides,
  };
}

describe("support feedback forwarding", () => {
  it("posts JSON to /v1/feedback with the WorkOS bearer and request id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { ok: true, id: "fb_1", attachments: "uploaded" }));
    const result = await forwardSupportFeedback("req_1", PAYLOAD, options({ fetchImpl }));

    expect(result).toEqual({ ok: true, id: "fb_1", attachments: "uploaded", code: null, status: 201, error: null });
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.example.test/v1/feedback");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(PAYLOAD));
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer session-token-1");
    expect(headers["x-ambient-request-id"]).toBe("req_1");
  });

  it("never audits the message or session token", async () => {
    const audit = new MemoryAuditSink();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { ok: true, id: "fb_1", attachments: "none" }));
    await forwardSupportFeedback("req_1", PAYLOAD, options({ audit, fetchImpl }));
    const serialized = JSON.stringify(audit.recent());
    expect(serialized).not.toContain("session-token-1");
    expect(serialized).not.toContain("Capture stopped");
    expect(audit.recent().map((event) => event.name)).toContain("analytics.support_feedback_complete");
  });

  it("returns the server's typed code for a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, {
      error: "Feedback is not configured on this server.",
      code: "feedback_not_configured",
    }));
    const result = await forwardSupportFeedback("req_1", PAYLOAD, options({ fetchImpl }));
    expect(result).toEqual({
      ok: false,
      id: null,
      attachments: null,
      code: "feedback_not_configured",
      status: 503,
      error: "Feedback is not configured on this server.",
    });
  });

  it("clears an invalid session on 401", async () => {
    const onUnauthorized = vi.fn().mockResolvedValue(true);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "nope", code: "unauthenticated" }));
    const result = await forwardSupportFeedback("req_1", PAYLOAD, options({ fetchImpl, onUnauthorized }));
    expect(result.code).toBe("unauthenticated");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("rejects while signed out without calling the server", async () => {
    const fetchImpl = vi.fn();
    const result = await forwardSupportFeedback("req_1", PAYLOAD, options({
      fetchImpl,
      readSession: async () => ({ kind: "signed_out" }),
    }));
    expect(result).toMatchObject({ ok: false, code: "signed_out" });
    expect(result.error).toContain("Sign in to Ambient Bridge");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a network failure as network_error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const result = await forwardSupportFeedback("req_1", PAYLOAD, options({ fetchImpl }));
    expect(result).toMatchObject({ ok: false, code: "network_error", error: "fetch failed" });
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
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status });
}
