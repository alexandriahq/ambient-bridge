import { describe, expect, it, vi } from "vitest";
import {
  AuthServerClient,
  AuthServerPlansError,
  AuthServerTimeoutError,
  AuthServerRequestError,
  AuthServerUsageError,
  createAuthLoginUrl,
  normalizeAuthServerBaseUrl,
  parseBridgeAuthCallback,
} from "../electron/auth/server-client.js";

const jsonRequests = [
  ["auth POST", (client: AuthServerClient) => client.validateSession("session-token")],
  ["public GET", (client: AuthServerClient) => client.announcements()],
  ["session GET", (client: AuthServerClient) => client.inferenceModels("session-token")],
  ["usage GET", (client: AuthServerClient) => client.usageSummary("session-token")],
] as const;

describe("server auth client", () => {
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

  it("folds millisecond session expiry from a buggy server into unix seconds", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        expiresAt: 1_800_000_000_000,
        featureFlags: [],
        sessionToken: "session_1",
        user: { email: "dev@example.com", id: "user_1", name: "Dev" },
      }),
    ) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.redeemTicket("ticket_1")).resolves.toMatchObject({
      expiresAt: 1_800_000_000,
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
        featureFlags: ["devtools-visible", "enable-agents", "devtools-visible", null, 7, "", "  ", " Custom "],
        organizationId: "org_1",
        sessionToken: "session_rotated",
        user: { email: "dev@example.com", id: "user_1", name: "Dev" },
      }),
    ) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.validateSession("session_1", { forceRefresh: true })).resolves.toEqual({
      expiresAt: 1_900_000_000,
      featureFlags: [" Custom ", "devtools-visible", "enable-agents"],
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
          { organizationId: "org_a", featureFlags: ["integrations-enabled", " Custom ", "integrations-enabled", null, false, ""] },
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
        { featureFlags: [" Custom ", "integrations-enabled"], organizationId: "org_a" },
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

  it.each(jsonRequests)("bounds %s requests with a typed timeout", async (_name, request) => {
    const hangingFetch = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    const client = new AuthServerClient({
      baseUrl: "http://localhost:3000",
      fetchImpl: hangingFetch,
      requestTimeoutMs: 1,
    });

    await expect(request(client)).rejects.toBeInstanceOf(AuthServerTimeoutError);
  });

  it.each(jsonRequests)("keeps the timeout active while consuming the %s response body", async (_name, request) => {
    const client = new AuthServerClient({
      baseUrl: "http://localhost:3000",
      fetchImpl: responseWithStalledBody(),
      requestTimeoutMs: 5,
    });

    await expect(request(client)).rejects.toBeInstanceOf(AuthServerTimeoutError);
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

  it("reads the authenticated ledger model breakdown", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      schemaVersion: 1,
      owner: { kind: "organization", id: "org_test" },
      currency: "USD",
      period: { kind: "lifetime" },
      rows: [{
        modelId: "glm-5-2",
        route: "/v1/chat/completions",
        requestCount: 3,
        promptTokens: 1000,
        completionTokens: 200,
        usedMicros: "450000",
      }],
      totalUsedMicros: "450000",
      updatedAt: "2026-07-20T12:00:00.000Z",
    })) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.usageModelBreakdown("session_secret")).resolves.toMatchObject({
      totalUsedMicros: "450000",
      rows: [{ modelId: "glm-5-2", usedMicros: "450000" }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(new URL("/usage/breakdown", "http://localhost:3000"), {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer session_secret",
      },
      method: "GET",
      signal: expect.any(AbortSignal),
    });
  });

  it("reads the authenticated public pricing catalog", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      schemaVersion: 1,
      version: "test-v1",
      prices: [{
        route: "/v1/chat/completions",
        modelId: "glm-5-2",
        billing: "tokens",
        inputMicrosPerMillion: "1500000",
        cacheInputMicrosPerMillion: null,
        outputMicrosPerMillion: "5250000",
        requestMicros: null,
        audioMicrosPerMinute: null,
        reservationMicros: "5250000",
      }, {
        route: "/v1/audio/transcriptions",
        modelId: "whisper-large-v3-turbo",
        billing: "audio_seconds",
        inputMicrosPerMillion: "0",
        cacheInputMicrosPerMillion: null,
        outputMicrosPerMillion: "0",
        requestMicros: null,
        audioMicrosPerMinute: "667",
        reservationMicros: "4000",
      }],
    })) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.usagePricing("session_secret")).resolves.toMatchObject({
      schemaVersion: 1,
      version: "test-v1",
      prices: [
        { modelId: "glm-5-2", billing: "tokens" },
        { modelId: "whisper-large-v3-turbo", billing: "audio_seconds" },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(new URL("/usage/pricing", "http://localhost:3000"), {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer session_secret",
      },
      method: "GET",
      signal: expect.any(AbortSignal),
    });
  });

  it("reads public in-app announcements without a session", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      schemaVersion: 1,
      announcements: [{
        id: "manual-update-2026-08",
        title: "Please update Ambient",
        body: "Download the latest installer.",
        severity: "warning",
        actionLabel: "Download update",
        actionUrl: "https://alexandria.so/download",
        dismissible: true,
        audience: "app",
        showBelowVersion: "1.4.0",
      }],
    })) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.announcements()).resolves.toMatchObject({
      schemaVersion: 1,
      announcements: [{ id: "manual-update-2026-08" }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(new URL("/announcements", "http://localhost:3000"), {
      headers: {
        Accept: "application/json",
      },
      method: "GET",
      signal: expect.any(AbortSignal),
    });
  });

  it("asks the public announcements feed for the signed-in organization", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      schemaVersion: 1,
      announcements: [],
    })) as unknown as typeof fetch;
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.announcements({ organizationId: "org_acme" })).resolves.toEqual({
      schemaVersion: 1,
      announcements: [],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("/announcements?organizationId=org_acme", "http://localhost:3000"),
      expect.objectContaining({ method: "GET" }),
    );
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

    expect(fetchImpl.mock.calls[0]?.[1]).toEqual({
      body: JSON.stringify({ requestId: "request_1", route: "/v1/chat/completions", modelId: "model_test" }),
      headers: { Accept: "application/json", Authorization: "Bearer session_secret", "Content-Type": "application/json" },
      method: "POST",
      signal: expect.any(AbortSignal),
    });
    expect(fetchImpl.mock.calls[1]?.[0]).toEqual(
      new URL("/usage/reservations/crr_abcdefghijklmnop", "http://localhost:3000"),
    );
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual({
      headers: { Accept: "application/json", Authorization: "Bearer session_secret" },
      method: "DELETE",
      signal: expect.any(AbortSignal),
    });
  });

  it("loads top-up options and creates Stripe Checkout sessions", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({
        schemaVersion: 1,
        enabled: true,
        mode: "test",
        publishableKey: "pk_test_publishable",
        packages: [{
          id: "credit_10",
          label: "$10",
          amountCents: 1_000,
          creditMicros: "10000000",
        }],
      }))
      .mockResolvedValueOnce(Response.json({
        schemaVersion: 1,
        sessionId: "cs_test_1",
        checkoutUrl: "https://checkout.stripe.test/pay/cs_test_1",
      }, { status: 201 }));
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.usageTopupOptions("session_secret")).resolves.toMatchObject({
      enabled: true,
      mode: "test",
      publishableKey: "pk_test_publishable",
    });
    await expect(client.createUsageTopupCheckout("session_secret", "credit_10")).resolves.toMatchObject({
      sessionId: "cs_test_1",
      checkoutUrl: "https://checkout.stripe.test/pay/cs_test_1",
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toEqual(new URL("/usage/topups", "http://localhost:3000"));
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ packageId: "credit_10" }),
      method: "POST",
    });
  });

  it("lists plans leniently, then opens checkout and the portal with the session token (ADR-0324)", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({
        eligible: true,
        required: true,
        plans: [{
          id: "plan_plus", name: "Plus", tagline: "For one person", highlights: ["Live reasoning"],
          priceMicros: "20000000", interval: "month", includedMicros: "15000000", purchasable: true, futureField: 1,
        }],
        subscription: null,
        manageable: false,
        addedLater: { anything: true },
      }))
      .mockResolvedValueOnce(Response.json({ checkoutUrl: "https://checkout.stripe.test/plan" }))
      .mockResolvedValueOnce(Response.json({ portalUrl: "https://billing.stripe.test/portal" }));
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    const plans = await client.accountPlans("session_secret");
    expect(plans).toEqual({
      eligible: true,
      required: true,
      plans: [{
        id: "plan_plus", name: "Plus", tagline: "For one person", highlights: ["Live reasoning"],
        priceMicros: "20000000", interval: "month", includedMicros: "15000000", purchasable: true,
      }],
      subscription: null,
      manageable: false,
    });
    await expect(client.createPlanCheckout("session_secret", "plan_plus")).resolves.toEqual({ checkoutUrl: "https://checkout.stripe.test/plan" });
    await expect(client.createPlanPortal("session_secret")).resolves.toEqual({ portalUrl: "https://billing.stripe.test/portal" });
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://localhost:3000/v1/plans",
      "http://localhost:3000/v1/plans/checkout",
      "http://localhost:3000/v1/plans/portal",
    ]);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer session_secret" } });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ planId: "plan_plus" }) });
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ method: "POST", body: "{}" });
  });

  it("refuses an invalid plan id locally and surfaces Cloud plan refusals with their code", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(
      { error: { code: "PLAN_NOT_PURCHASABLE", message: "This plan cannot be bought right now." } },
      { status: 409 },
    ));
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });
    await expect(client.createPlanCheckout("session_secret", "org_123")).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();

    const failure = await client.createPlanCheckout("session_secret", "plan_plus").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuthServerPlansError);
    expect(failure).toMatchObject({ status: 409, code: "PLAN_NOT_PURCHASABLE", message: "This plan cannot be bought right now." });

    fetchImpl.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(client.accountPlans("session_secret")).rejects.toBeInstanceOf(AuthServerRequestError);
  });

  it("opts into custom amounts and forwards exact cents without changing the owner", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, enabled: true, mode: "test", publishableKey: "pk_test_example", packages: [],
        customAmount: { minAmountCents: 100, maxAmountCents: 1_000_000 } }))
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, sessionId: "cs_custom", checkoutUrl: "https://checkout.stripe.test/custom" }));
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });
    expect(await client.usageTopupOptions("session_secret", true)).toHaveProperty("customAmount.minAmountCents", 100);
    await client.createUsageTopupCheckout("session_secret", { amountCents: 1234 });
    expect(fetchImpl.mock.calls[0]?.[0]).toEqual(new URL("/usage/topups?customAmounts=true", "http://localhost:3000"));
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ body: JSON.stringify({ amountCents: 1234 }), method: "POST" });
  });

  it("reads and changes usage billing through the session-authenticated routes", async () => {
    const state = {
      schemaVersion: 1,
      owner: { kind: "user", id: "user_b2c" },
      scope: "personal",
      organization: null,
      canManage: true,
      usageBillingAvailable: true,
      publishableKey: "pk_test_abc",
      mode: "usage",
      status: "active",
      meteredActive: false,
      paymentMethod: null,
      spendingLimit: null,
      limitWindow: null,
      currentMonth: { startsAt: "2026-10-01T00:00:00.000Z", spentMicros: "0", meteredMicros: "0" },
      blockedReason: "needs_payment_method",
      portalUrl: null,
      summary: { ...usageSummary("0"), owner: { kind: "user", id: "user_b2c" } },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(state))
      .mockResolvedValueOnce(Response.json({
        schemaVersion: 1,
        setupIntentId: "seti_1",
        clientSecret: "seti_1_secret_abc",
        publishableKey: "pk_test_abc",
      }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ ...state, meteredActive: true, paymentMethod: { brand: "Visa", last4: "4242", expMonth: 12, expYear: 2030 }, blockedReason: null }))
      .mockResolvedValueOnce(Response.json({ ...state, spendingLimit: { amountMicros: "50000000", period: "month" } }))
      .mockResolvedValueOnce(Response.json({ error: { code: "BILLING_FORBIDDEN", message: "Admins only." } }, { status: 403 }));
    const client = new AuthServerClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.usageBillingState("session_secret")).resolves.toMatchObject({ mode: "usage", blockedReason: "needs_payment_method" });
    await expect(client.createUsageBillingSetupIntent("session_secret")).resolves.toMatchObject({ clientSecret: "seti_1_secret_abc" });
    await expect(client.attachUsageBillingPaymentMethod("session_secret", "seti_1")).resolves.toMatchObject({ paymentMethod: { last4: "4242" } });
    await expect(client.setUsageSpendingLimit("session_secret", { amountMicros: "50000000", period: "month" }))
      .resolves.toMatchObject({ spendingLimit: { period: "month" } });
    await expect(client.removeUsageBillingPaymentMethod("session_secret")).rejects.toMatchObject({ code: "BILLING_FORBIDDEN", status: 403 });

    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), (init as RequestInit).method])).toEqual([
      ["http://localhost:3000/usage/billing", "GET"],
      ["http://localhost:3000/usage/billing/setup-intent", "POST"],
      ["http://localhost:3000/usage/billing/payment-method", "PUT"],
      ["http://localhost:3000/usage/billing/spending-limit", "PUT"],
      ["http://localhost:3000/usage/billing/payment-method", "DELETE"],
    ]);
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ body: JSON.stringify({ setupIntentId: "seti_1" }) });
    expect(fetchImpl.mock.calls[3]?.[1]).toMatchObject({ body: JSON.stringify({ limit: { amountMicros: "50000000", period: "month" } }) });
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

describe.each(jsonRequests)("%s response contract", (name, request) => {
  it.each(["AbortError", "TimeoutError", "TypeError"])("preserves fetch %s classification without retry", async (errorName) => {
    const failure = Object.assign(new Error("fetch failed"), { name: errorName });
    const fetchImpl = vi.fn().mockRejectedValue(failure);
    const client = new AuthServerClient({ baseUrl: "https://bridge.test", fetchImpl });
    if (errorName === "TypeError") await expect(request(client)).rejects.toBe(failure);
    else await expect(request(client)).rejects.toBeInstanceOf(AuthServerTimeoutError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["AbortError", "SyntaxError", "TimeoutError"])("preserves body %s classification after HTTP failure", async (errorName) => {
    const response = new Response(null, { status: 503 });
    const readBody = vi.spyOn(response, "json").mockRejectedValue(Object.assign(new Error("body failed"), { name: errorName }));
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const client = new AuthServerClient({ baseUrl: "https://bridge.test", fetchImpl });
    if (errorName === "TimeoutError") await expect(request(client)).rejects.toBeInstanceOf(AuthServerTimeoutError);
    else await expect(request(client)).rejects.toMatchObject({
      name: "AuthServerRequestError",
      status: 503,
      serverMessage: name === "usage GET" ? "Usage response was unavailable." : undefined,
    });
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it.each([401, 402, 503])("retains HTTP %s error policy", async (status) => {
    const body = { error: { code: "INSUFFICIENT_CREDIT", message: "No credit." }, summary: usageSummary("0") };
    const response = Response.json(body, { status });
    const readBody = vi.spyOn(response, "json");
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const client = new AuthServerClient({ baseUrl: "https://bridge.test", fetchImpl });
    const failure = await request(client).catch(error => error);
    if (name === "usage GET") {
      expect(failure).toBeInstanceOf(AuthServerUsageError);
      expect(failure).toMatchObject({ status, code: "INSUFFICIENT_CREDIT", serverMessage: "No credit.", summary: usageSummary("0") });
    } else {
      expect(failure).toBeInstanceOf(AuthServerRequestError);
      expect(failure).toMatchObject({ status, serverMessage: undefined, message: `Server request failed: ${status}` });
    }
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retains an empty auth error string and the usage fallback", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ error: "" }, { status: 401 }));
    const client = new AuthServerClient({ baseUrl: "https://bridge.test", fetchImpl });
    const message = name === "usage GET" ? "Usage response was unavailable." : "";
    await expect(request(client)).rejects.toMatchObject({ name: "AuthServerRequestError", status: 401, serverMessage: message, message: `Server request failed: ${message}` });
  });

  it("leaves parser failures outside transport timeout classification", async () => {
    const failure = Object.assign(new Error("invalid response field"), { name: "TimeoutError" });
    const response = new Response();
    vi.spyOn(response, "json").mockResolvedValue(new Proxy({}, { get: (_target, key) => {
      if (key === "then") return undefined; // Fail in the parser, after Promise resolution.
      throw failure;
    } }));
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const client = new AuthServerClient({ baseUrl: "https://bridge.test", fetchImpl });
    await expect(request(client)).rejects.toBe(failure);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("request construction boundaries", () => {
  it("keeps authenticated model requests body-free", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({}, { status: 503 }));
    const client = new AuthServerClient({ baseUrl: "https://bridge.test/base/", fetchImpl });
    await expect(client.inferenceModels("session_secret")).rejects.toBeInstanceOf(AuthServerRequestError);
    expect(fetchImpl).toHaveBeenCalledWith(new URL("https://bridge.test/inference/models"), {
      headers: { Accept: "application/json", Authorization: "Bearer session_secret" },
      method: "GET",
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps auth serialization asynchronous and inside fetch error classification", async () => {
    const failure = Object.assign(new Error("serialization failed"), { name: "AbortError" });
    const input = { toJSON() { throw failure; } } as unknown as string;
    const fetchImpl = vi.fn();
    const client = new AuthServerClient({ baseUrl: "https://bridge.test", fetchImpl });
    await expect(client.redeemTicket(input)).rejects.toBeInstanceOf(AuthServerTimeoutError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps usage serialization synchronous and rejects invalid release IDs before fetch", async () => {
    const failure = new Error("serialization failed");
    const input = { toJSON() { throw failure; } } as unknown as Parameters<AuthServerClient["reserveUsage"]>[1];
    const fetchImpl = vi.fn();
    const client = new AuthServerClient({ baseUrl: "https://bridge.test", fetchImpl });
    expect(() => client.reserveUsage("session_secret", input)).toThrow(failure);
    await expect(client.releaseUsage("session_secret", "../other")).rejects.toThrow("Inference reservation identity is invalid.");
    expect(fetchImpl).not.toHaveBeenCalled();
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
