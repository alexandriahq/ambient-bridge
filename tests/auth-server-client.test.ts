import { describe, expect, it, vi } from "vitest";
import {
  AuthServerClient,
  AuthServerRequestError,
  createAuthLoginUrl,
  normalizeAuthServerBaseUrl,
  parseBridgeAuthCallback,
  serverBaseUrlFromEnv,
} from "../electron/auth/server-client.js";

describe("server auth client", () => {
  it("reads the Bridge server URL from the environment", () => {
    expect(serverBaseUrlFromEnv({})).toBe("https://api.alexandria.so");
    expect(serverBaseUrlFromEnv({ AMBIENT_SERVER_URL: "http://localhost:3000/" })).toBe("http://localhost:3000");
    expect(serverBaseUrlFromEnv({ AMBIENT_AUTH_SERVER_URL: "http://legacy.example/" })).toBe(
      "http://legacy.example",
    );
    expect(
      serverBaseUrlFromEnv({
        AMBIENT_AUTH_SERVER_URL: "http://legacy.example/",
        AMBIENT_SERVER_URL: "https://api.example/",
      }),
    ).toBe("https://api.example");
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
    await expect(
      new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl: failedResponse }).checkHealth(),
    ).resolves.toBe(false);

    const failedFetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl: failedFetch }).checkHealth(),
    ).resolves.toBe(false);
  });

});
