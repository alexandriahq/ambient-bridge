import { describe, expect, it, vi } from "vitest";
import { BUILD_DEFAULT_SERVER_URL } from "../electron/generated/build-config.js";
import {
  AuthServerClient,
  AuthServerTimeoutError,
  AuthServerRequestError,
  AuthServerUsageError,
  createAuthLoginUrl,
  normalizeAuthServerBaseUrl,
  parseBridgeAuthCallback,
  resolveServerBaseUrl,
} from "../electron/auth/server-client.js";

describe("server auth client", () => {
  it("resolves the Bridge server URL from the build-time baked default", () => {
    // The server a build talks to is fixed at build time. Standard releases use
    // production; staging/local builds require an explicit build-time override.
    expect(resolveServerBaseUrl()).toBe(BUILD_DEFAULT_SERVER_URL);
  });

  it("builds the Bridge login URL for the server", () => {
    expect(normalizeAuthServerBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(
      createAuthLoginUrl({
        baseUrl: "http://localhost:3000/",
        clientState: "state_1234567890123456",
        returnUri: "ambient-bridge://auth/callback",
      }),
    ).toBe(
      "http://localhost:3000/auth/login?return_uri=ambient-bridge%3A%2F%2Fauth%2Fcallback&client_state=state_1234567890123456",
    );
    expect(new AuthServerClient({ baseUrl: "http://localhost:3000" }).createLoginUrl(
      "state_1234567890123456",
      "http://127.0.0.1:49152/auth/callback",
    )).toBe(
      "http://localhost:3000/auth/login?return_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fauth%2Fcallback&client_state=state_1234567890123456",
    );
  });

  it("parses and validates Bridge auth callbacks", () => {
    expect(
      parseBridgeAuthCallback(
        "ambient-bridge://auth/callback?ticket=ticket_1&client_state=state_1",
        "state_1",
      ),
    ).toEqual({
      clientState: "state_1",
      kind: "success",
      ticket: "ticket_1",
    });

    expect(() =>
      parseBridgeAuthCallback(
        "ambient-bridge://auth/callback?ticket=ticket_1&client_state=state_1",
        "state_2",
      ),
    ).toThrow("state did not match");
  });

  it("redeems auth tickets through the server", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        expiresAt: 1_800_000_000,
        featureFlags: [],
        sessionToken: "session_1",
        user: { email: "dev@example.com", id: "user_1", name: "Dev" },
      }),
    ) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.redeemTicket("ticket_1")).resolves.toEqual({
      expiresAt: 1_800_000_000,
      organizationId: null,
      featureFlags: [],
      sessionToken: "session_1",
      user: {
        email: "dev@example.com",
        id: "user_1",
        name: "Dev",
        firstName: null,
        lastName: null,
        profilePictureUrl: null,
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(new URL("/auth/redeem", "http://localhost:3000"), {
      body: JSON.stringify({ ticket: "ticket_1" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: expect.any(AbortSignal),
    });
  });

  it("requests delegated integration tokens through the server", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        expiresAt: 1_800_000_000,
        scope: "integrations",
        token: "ambdt_v1.payload.signature",
      }),
    ) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.createIntegrationToken("session_1")).resolves.toEqual({
      expiresAt: 1_800_000_000,
      scope: "integrations",
      serverBaseUrl: "http://localhost:3000",
      session: null,
      token: "ambdt_v1.payload.signature",
    });

    expect(fetchImpl).toHaveBeenCalledWith(new URL("/auth/delegate", "http://localhost:3000"), {
      body: JSON.stringify({ scope: "integrations", sessionToken: "session_1" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: expect.any(AbortSignal),
    });
  });

  it("reads feature flag slugs from validated sessions", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        expiresAt: 1_900_000_000,
        featureFlags: ["context-handoff-available", "devtools-visible"],
        organizationId: "org_1",
        sessionToken: "session_rotated",
        user: { email: "dev@example.com", id: "user_1", name: "Dev" },
      }),
    ) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.validateSession("session_1", { forceRefresh: true })).resolves.toEqual({
      expiresAt: 1_900_000_000,
      featureFlags: ["context-handoff-available", "devtools-visible"],
      organizationId: "org_1",
      sessionToken: "session_rotated",
      user: {
        email: "dev@example.com",
        firstName: null,
        id: "user_1",
        lastName: null,
        name: "Dev",
        profilePictureUrl: null,
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(new URL("/auth/session", "http://localhost:3000"), {
      body: JSON.stringify({ forceRefresh: true, sessionToken: "session_1" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: expect.any(AbortSignal),
    });
  });

  it("reads per-organization feature flags from organization responses", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        featureFlagsByOrganization: [
          { organizationId: "org_b", featureFlags: [] },
          { organizationId: "org_a", featureFlags: ["integrations-enabled"] },
        ],
        organizations: [
          { id: "org_a", name: "Acme" },
          { id: "org_b", name: "Beta" },
        ],
        organizationId: "org_a",
      }),
    ) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.listOrganizations("session_1", { includeFeatureFlags: true })).resolves.toEqual({
      featureFlagsByOrganization: [
        { featureFlags: ["integrations-enabled"], organizationId: "org_a" },
        { featureFlags: [], organizationId: "org_b" },
      ],
      organizations: [
        { id: "org_a", name: "Acme" },
        { id: "org_b", name: "Beta" },
      ],
      organizationId: "org_a",
      session: null,
    });

    expect(fetchImpl).toHaveBeenCalledWith(new URL("/auth/organizations", "http://localhost:3000"), {
      body: JSON.stringify({ includeFeatureFlags: true, sessionToken: "session_1" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: expect.any(AbortSignal),
    });
  });

  it("returns the rotated session from delegated integration token responses", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        expiresAt: 1_800_000_000,
        scope: "integrations",
        session: {
          expiresAt: 1_900_000_000,
          featureFlags: [],
          organizationId: null,
          sessionToken: "session_rotated",
          user: { email: "dev@example.com", id: "user_1", name: "Dev" },
        },
        token: "ambdt_v1.payload.signature",
      }),
    ) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.createIntegrationToken("session_1")).resolves.toEqual({
      expiresAt: 1_800_000_000,
      scope: "integrations",
      serverBaseUrl: "http://localhost:3000",
      session: {
        expiresAt: 1_900_000_000,
        featureFlags: [],
        organizationId: null,
        sessionToken: "session_rotated",
        user: {
          email: "dev@example.com",
          id: "user_1",
          name: "Dev",
          firstName: null,
          lastName: null,
          profilePictureUrl: null,
        },
      },
      token: "ambdt_v1.payload.signature",
    });
  });

  it("throws typed request errors for rejected sessions", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "expired" }, { status: 401 })) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.validateSession("stale_session")).rejects.toMatchObject({
      message: "Server request failed: expired",
      serverMessage: "expired",
      status: 401,
    });
    await expect(client.validateSession("stale_session")).rejects.toBeInstanceOf(AuthServerRequestError);
  });

  it("checks server health through /healthz", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.checkHealth()).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledWith(new URL("/healthz", "http://localhost:3000"), {
      headers: { Accept: "application/json" },
      method: "GET",
      signal: expect.any(AbortSignal),
    });
  });

  it("reports server health as unavailable on failed probes", async () => {
    const failedResponse = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const serverDownClient = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl: failedResponse });
    await expect(serverDownClient.checkHealth()).resolves.toBe(false);
    await expect(serverDownClient.checkHealthDetailed()).resolves.toMatchObject({
      httpStatus: 503,
      message: "Ambient server health check returned HTTP 503.",
      reachable: false,
      reason: "server_error",
    });

    const failedFetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl: failedFetch }).checkHealth(),
    ).resolves.toBe(false);
  });

  it("classifies DNS and offline health failures without exposing raw errors", async () => {
    const dnsError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND secret-host"), { code: "ENOTFOUND" }),
    });
    const dnsFetch = vi.fn(async () => {
      throw dnsError;
    }) as unknown as typeof fetch;

    await expect(
      new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl: dnsFetch }).checkHealthDetailed(),
    ).resolves.toMatchObject({
      message: "DNS lookup for the Ambient server failed.",
      reachable: false,
      reason: "dns_failure",
    });

    const offlineFetch = vi.fn(async () => {
      throw Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" });
    }) as unknown as typeof fetch;
    await expect(
      new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl: offlineFetch }).checkHealthDetailed(),
    ).resolves.toMatchObject({
      message: "No internet route is available for Ambient Bridge.",
      reachable: false,
      reason: "offline",
    });
  });

  it("bounds auth requests with a typed timeout", async () => {
    const hangingFetch = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    const client = new AuthServerClient({
      baseUrl: "http://localhost:3000",
      fetchImpl: hangingFetch,
      requestTimeoutMs: 1,
    });

    await expect(client.validateSession("session-token")).rejects.toBeInstanceOf(AuthServerTimeoutError);
  });

  it("keeps the timeout active while consuming the auth response body", async () => {
    const client = new AuthServerClient({
      baseUrl: "http://localhost:3000",
      fetchImpl: responseWithStalledBody(),
      requestTimeoutMs: 5,
    });

    await expect(client.validateSession("session-token")).rejects.toBeInstanceOf(AuthServerTimeoutError);
  });

  it("reads exact authenticated usage summaries without putting the session in the body", async () => {
    const fetchImpl = vi.fn(async () => Response.json(usageSummary("2500000"))) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.usageSummary("session_secret")).resolves.toMatchObject({
      grantedMicros: "10000000",
      remainingMicros: "2500000",
      usedMicros: "7500000",
    });
    expect(fetchImpl).toHaveBeenCalledWith(new URL("/usage/summary", "http://localhost:3000"), {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer session_secret",
      },
      method: "GET",
      signal: expect.any(AbortSignal),
    });
  });

  it("reserves and releases inference credit through typed control-plane calls", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({
        reservationId: "crr_abcdefghijklmnop",
        reservedMicros: "500000",
        expiresAt: "2026-07-20T12:15:00.000Z",
        summary: usageSummary("2000000"),
      }, { status: 201 }))
      .mockResolvedValueOnce(Response.json(usageSummary("2500000")));
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.reserveUsage("session_secret", {
      requestId: "request_1",
      route: "/v1/chat/completions",
      modelId: "model_test",
    })).resolves.toMatchObject({ reservationId: "crr_abcdefghijklmnop" });
    await expect(client.releaseUsage("session_secret", "crr_abcdefghijklmnop"))
      .resolves.toMatchObject({ remainingMicros: "2500000" });

    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ requestId: "request_1", route: "/v1/chat/completions", modelId: "model_test" }),
      method: "POST",
    });
    expect(fetchImpl.mock.calls[1]?.[0]).toEqual(
      new URL("/usage/reservations/crr_abcdefghijklmnop", "http://localhost:3000"),
    );
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("keeps a server-authenticated account exhaustion error typed and distinct", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      error: { code: "INSUFFICIENT_CREDIT", message: "No usable inference credit remains." },
      summary: usageSummary("0"),
    }, { status: 402 })) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.reserveUsage("session_secret", {
      requestId: "request_1",
      route: "/v1/chat/completions",
      modelId: "model_test",
    })).rejects.toMatchObject({
      code: "INSUFFICIENT_CREDIT",
      status: 402,
      summary: { remainingMicros: "0" },
    });
    await expect(client.reserveUsage("session_secret", {
      requestId: "request_2",
      route: "/v1/chat/completions",
      modelId: "model_test",
    })).rejects.toBeInstanceOf(AuthServerUsageError);
  });

});

function usageSummary(remainingMicros: string) {
  return {
    schemaVersion: 1,
    owner: { kind: "organization", id: "org_test" },
    currency: "USD",
    period: { kind: "lifetime" },
    mode: "metered",
    grantedMicros: "10000000",
    usedMicros: remainingMicros === "0" ? "10000000" : "7500000",
    reservedMicros: "0",
    remainingMicros,
    updatedAt: "2026-07-20T12:00:00.000Z",
  };
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
