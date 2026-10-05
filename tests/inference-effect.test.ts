import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  BridgeAuditService,
  BridgeSecureClient,
  BridgeSessionService,
  createBridgeAuditService,
  createBridgeSecureClient,
  createBridgeSessionService,
  secureInferenceResponse,
  type SecureClientFactory,
} from "../electron/inference/effect.js";
import { MemoryAuditSink } from "../electron/diagnostics/audit.js";
import type { SignedInWorkOsSession } from "../electron/workos/session.js";
import type { UsageSummary } from "@ambient/shared/usage";
import { InferenceAvailabilityCircuit } from "../electron/inference/availability.js";
import { BridgeInferenceServiceError, BridgeUsageRequestError } from "../electron/inference/errors.js";
import {
  BridgeUsageAccountingDisabledError,
  type BridgeUsageService,
} from "../electron/inference/usage-service.js";

describe("Bridge secure inference Effect service", () => {
  it("fails signed-out requests before verifying the Tinfoil client", async () => {
    const ready = vi.fn(async () => {});
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: async () => new Response("not used"),
        ready,
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });

    const result = await Effect.runPromise(Effect.either(
      secureInferenceResponse({
        appVersion: "0.1.0",
        feature: "inference.responses",
        path: "/v1/responses",
        payload: { input: "hello" },
        requestId: "req_1",
        signal: new AbortController().signal,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({
          read: async () => ({ kind: "signed_out" }),
        })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    ));

    expect(result._tag).toBe("Left");
    expect(ready).not.toHaveBeenCalled();
  });

  it("configures SecureClient for the Ambient server and sends WorkOS auth headers", async () => {
    const calls: {
      options?: unknown;
      input?: RequestInfo | URL;
      init?: RequestInit;
    } = {};
    const ready = vi.fn(async () => {});
    const secureClient = createBridgeSecureClient({
      makeSecureClient: ((options) => {
        calls.options = options;
        return {
          fetch: async (input, init) => {
            calls.input = input;
            calls.init = init;
            return new Response("ok");
          },
          ready,
        };
      }) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });

    const response = await Effect.runPromise(
      secureInferenceResponse({
        appVersion: "0.1.0",
        feature: "inference.chatCompletions",
        path: "/v1/chat/completions",
        payload: { messages: [], model: "model_test", stream: true },
        requestId: "req_2",
        signal: new AbortController().signal,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({
          read: async () => ({
            email: "user@example.test",
            expiresAt: 1_700_000_000,
            kind: "signed_in",
            sessionToken: "sealed_session_test",
            user: { email: "user@example.test", id: "user_1", name: null },
          }),
        })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    );

    expect(await response.text()).toBe("ok");
    expect(ready).toHaveBeenCalledTimes(1);
    expect(calls.options).toEqual({
      attestationBundleURL: "https://api.example.test",
      baseURL: "https://api.example.test",
    });
    expect(calls.input).toBe("/v1/chat/completions");
    const headers = new Headers(calls.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sealed_session_test");
    expect(headers.get("x-ambient-request-id")).toBe("req_2");
    expect(headers.get("x-ambient-app-version")).toBe("0.1.0");
    expect(headers.get("x-ambient-feature")).toBe("inference.chatCompletions");
    expect(headers.get("x-ambient-model-id")).toBe("model_test");
    expect(calls.init?.body).toBe(JSON.stringify({ messages: [], model: "model_test", stream: true }));
  });

  it("reserves credit before secure egress and sends the opaque reservation identity", async () => {
    const calls: { init?: RequestInit } = {};
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: async (_input, init) => {
          calls.init = init;
          return new Response("ok");
        },
        ready: async () => {},
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });
    const usage = usageService();
    const availability = new InferenceAvailabilityCircuit();

    const response = await Effect.runPromise(
      secureInferenceResponse({
        appVersion: "0.1.0",
        availability,
        feature: "inference.chatCompletions",
        path: "/v1/chat/completions",
        payload: { messages: [], model: "model_test" },
        requestId: "req_credit",
        signal: new AbortController().signal,
        usage,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({ read: async () => signedInSession() })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    );

    expect(await response.text()).toBe("ok");
    expect(usage.reserve).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "model_test",
      requestId: "req_credit",
      route: "/v1/chat/completions",
    }));
    expect(new Headers(calls.init?.headers).get("x-ambient-credit-reservation")).toBe("crr_test_abcdefghijklmnop");
    expect(usage.release).not.toHaveBeenCalled();
  });

  it("automatically recovers a half-open availability probe after a successful request", async () => {
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: async () => new Response("not used"),
        ready: async () => {},
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });
    const usage = usageService();
    const availability = new InferenceAvailabilityCircuit();
    availability.serviceUnavailable(
      new BridgeInferenceServiceError("UPSTREAM_BILLING_UNAVAILABLE", 503, 60),
      Date.now() - 60_000,
    );

    const response = await Effect.runPromise(
      secureInferenceResponse({
        appVersion: "0.1.0",
        availability,
        feature: "inference.chatCompletions",
        path: "/v1/chat/completions",
        payload: { messages: [], model: "model_test" },
        requestId: "req_usage_recovery_probe",
        signal: new AbortController().signal,
        usage,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({ read: async () => signedInSession() })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    );

    expect(await response.text()).toBe("not used");
    expect(availability.snapshot("organization:org_test")).toEqual({ state: "ready" });
  });

  it("re-arms a half-open availability probe after a non-transient reservation failure", async () => {
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: async () => new Response("not used"),
        ready: async () => {},
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });
    const usage = usageService();
    usage.reserve.mockImplementationOnce(() => Effect.fail(
      new BridgeUsageRequestError("permanent reservation failure"),
    ));
    const availability = new InferenceAvailabilityCircuit();
    const serviceError = new BridgeInferenceServiceError("UPSTREAM_BILLING_UNAVAILABLE", 503, 60);
    availability.serviceUnavailable(serviceError, Date.now() - 60_000);

    const result = await Effect.runPromise(Effect.either(
      secureInferenceResponse({
        appVersion: "0.1.0",
        availability,
        feature: "inference.chatCompletions",
        path: "/v1/chat/completions",
        payload: { messages: [], model: "model_test" },
        requestId: "req_usage_failed_probe",
        signal: new AbortController().signal,
        usage,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({ read: async () => signedInSession() })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    ));

    expect(result._tag).toBe("Left");
    expect(availability.snapshot("organization:org_test")).toMatchObject({
      state: "service_degraded",
      code: "UPSTREAM_BILLING_UNAVAILABLE",
    });
    expect(() => availability.beforeRequest("organization:org_test")).toThrow(BridgeInferenceServiceError);
    expect(() => availability.beforeRequest("organization:org_test", Date.now() + 60_000)).not.toThrow();
  });

  it("uses the server's compatible unmetered path only when accounting is explicitly disabled", async () => {
    const calls: { init?: RequestInit } = {};
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: async (_input, init) => {
          calls.init = init;
          return new Response("ok");
        },
        ready: async () => {},
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });
    const usage = usageService();
    usage.reserve.mockImplementationOnce(() => Effect.fail(new BridgeUsageAccountingDisabledError()));

    const response = await Effect.runPromise(
      secureInferenceResponse({
        appVersion: "0.1.0",
        feature: "inference.chatCompletions",
        path: "/v1/chat/completions",
        payload: { messages: [], model: "model_test" },
        requestId: "req_unmetered_compatibility",
        signal: new AbortController().signal,
        usage,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({ read: async () => signedInSession() })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    );

    expect(await response.text()).toBe("ok");
    expect(new Headers(calls.init?.headers).has("x-ambient-credit-reservation")).toBe(false);
    expect(usage.release).not.toHaveBeenCalled();
  });

  it("does not retry a credited request during a provider outage and releases it without opening account exhaustion", async () => {
    let attempts = 0;
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: async () => {
          attempts += 1;
          throw new BridgeInferenceServiceError("UPSTREAM_BILLING_UNAVAILABLE", 503, 60);
        },
        ready: async () => {},
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });
    const usage = usageService();
    const availability = new InferenceAvailabilityCircuit();

    const result = await Effect.runPromise(Effect.either(
      secureInferenceResponse({
        appVersion: "0.1.0",
        availability,
        feature: "inference.chatCompletions",
        path: "/v1/chat/completions",
        payload: { messages: [], model: "model_test" },
        requestId: "req_provider_outage",
        signal: new AbortController().signal,
        usage,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({ read: async () => signedInSession() })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    ));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(BridgeInferenceServiceError);
    expect(attempts).toBe(1);
    expect(usage.release).toHaveBeenCalledWith(expect.anything(), "crr_test_abcdefghijklmnop");
    expect(availability.snapshot("organization:org_test")).toMatchObject({
      state: "service_degraded",
      code: "UPSTREAM_BILLING_UNAVAILABLE",
    });
  });

  it("classifies returned plaintext billing failures before recovering the circuit", async () => {
    let attempts = 0;
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: async () => {
          attempts += 1;
          return new Response("private billing details", { status: 503, headers: {
            "x-ambient-error-code": "UPSTREAM_BILLING_UNAVAILABLE",
            "x-ambient-error-source": "openrouter_provider", "retry-after": "60",
          } });
        },
        ready: async () => {},
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });
    const usage = usageService();
    const availability = new InferenceAvailabilityCircuit();

    const result = await Effect.runPromise(Effect.either(
      secureInferenceResponse({
        appVersion: "0.1.0",
        availability,
        feature: "inference.chatCompletions",
        path: "/v1/chat/completions",
        payload: { messages: [], model: "model_test" },
        requestId: "req_provider_outage",
        signal: new AbortController().signal,
        usage,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({ read: async () => signedInSession() })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    ));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(BridgeInferenceServiceError);
    expect(attempts).toBe(1);
    expect(usage.release).toHaveBeenCalledWith(expect.anything(), "crr_test_abcdefghijklmnop");
    expect(availability.snapshot("organization:org_test")).toMatchObject({
      state: "service_degraded",
      code: "UPSTREAM_BILLING_UNAVAILABLE",
    });
  });

  it("validates and uses refreshed sessions before secure requests", async () => {
    const calls: { init?: RequestInit } = {};
    const events: string[] = [];
    const ready = vi.fn(async () => {
      events.push("ready");
    });
    const validate = vi.fn(async (session: SignedInWorkOsSession) => {
      events.push("validate");
      return {
        ...session,
        expiresAt: 1_800_000_000,
        sessionToken: "sealed_session_refreshed",
      };
    });
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: async (_input, init) => {
          events.push("fetch");
          calls.init = init;
          return new Response("ok");
        },
        ready,
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });

    await Effect.runPromise(
      secureInferenceResponse({
        appVersion: "0.1.0",
        feature: "inference.responses",
        path: "/v1/responses",
        payload: { input: "hello" },
        requestId: "req_refresh",
        signal: new AbortController().signal,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({
          read: async () => ({
            email: "user@example.test",
            expiresAt: 1_700_000_000,
            kind: "signed_in",
            sessionToken: "sealed_session_old",
            user: { email: "user@example.test", id: "user_1", name: null },
          }),
          validate,
        })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    );

    expect(validate).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["validate", "ready", "fetch"]);
    expect(new Headers(calls.init?.headers).get("authorization")).toBe("Bearer sealed_session_refreshed");
  });

  it("fails session validation before verifying the Tinfoil client", async () => {
    const ready = vi.fn(async () => {});
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: async () => new Response("not used"),
        ready,
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });

    const result = await Effect.runPromise(Effect.either(
      secureInferenceResponse({
        appVersion: "0.1.0",
        feature: "inference.responses",
        path: "/v1/responses",
        payload: { input: "hello" },
        requestId: "req_invalid_session",
        signal: new AbortController().signal,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({
          read: async () => ({
            email: "user@example.test",
            expiresAt: 1_700_000_000,
            kind: "signed_in",
            sessionToken: "sealed_session_old",
            user: { email: "user@example.test", id: "user_1", name: null },
          }),
          validate: async () => {
            throw new Error("invalid session");
          },
        })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    ));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toBe("Could not validate Bridge WorkOS session: invalid session");
    }
    expect(ready).not.toHaveBeenCalled();
  });

  it.each([
    { name: "daily report", path: "/v1/responses" as const, feature: "inference.dailyReport", stream: false, delay: 170_000, succeeds: true },
    { name: "Responses with stream omitted", path: "/v1/responses" as const, feature: "inference.responses", delay: 170_000, succeeds: true },
    { name: "stalled non-streaming Responses", path: "/v1/responses" as const, feature: "inference.responses", stream: false, delay: 181_000, succeeds: false },
    { name: "streaming Responses", path: "/v1/responses" as const, feature: "inference.responses", stream: true, delay: 121_000, succeeds: false },
    { name: "chat completions", path: "/v1/chat/completions" as const, feature: "inference.chatCompletions", stream: false, delay: 121_000, succeeds: false },
    { name: "explicit timeout override", path: "/v1/responses" as const, feature: "inference.responses", stream: false, delay: 110_000, responseTimeoutMs: 100_000, succeeds: false },
  ])("uses the correct delayed-header budget for $name", async (scenario) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let started!: () => void;
      const fetching = new Promise<void>((resolve) => { started = resolve; });
      let fetchSignal: AbortSignal | undefined;
      const secureClient = createBridgeSecureClient({
        makeSecureClient: (() => ({
          fetch: (_input, init) => new Promise<Response>((resolve, reject) => {
            fetchSignal = init?.signal;
            const timer = setTimeout(() => resolve(new Response("completed")), scenario.delay);
            fetchSignal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(fetchSignal?.reason);
            }, { once: true });
            started();
          }),
          ready: async () => {},
        })) satisfies SecureClientFactory,
        serverBaseUrl: "https://api.example.test",
      });
      const resultPromise = Effect.runPromise(Effect.either(secureInferenceResponse({
        appVersion: "0.1.0",
        feature: scenario.feature,
        path: scenario.path,
        payload: { input: "synthetic", ...(scenario.stream === undefined ? {} : { stream: scenario.stream }) },
        requestId: "req_header_budget",
        responseTimeoutMs: scenario.responseTimeoutMs,
        signal: new AbortController().signal,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({ read: async () => ({
          email: "user@example.test", expiresAt: 1_700_000_000, kind: "signed_in",
          sessionToken: "sealed_session_test", user: { email: "user@example.test", id: "user_1", name: null },
        }) })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      )));
      await fetching;
      await vi.advanceTimersByTimeAsync(scenario.delay);
      const result = await resultPromise;
      expect(result._tag).toBe(scenario.succeeds ? "Right" : "Left");
      if (result._tag === "Right") {
        expect(await result.right.text()).toBe("completed");
        await vi.advanceTimersByTimeAsync(180_000);
        expect(fetchSignal?.aborted).toBe(false);
      } else {
        expect(result.left.message).toContain("timed out");
        expect(fetchSignal?.aborted).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the fetch when the enclave never returns response headers in time", async () => {
    const ready = vi.fn(async () => {});
    // A fetch that hangs until its abort signal fires — mimics a stalled enclave.
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return;
            signal.addEventListener("abort", () => {
              reject(signal.reason ?? new DOMException("aborted", "AbortError"));
            });
          }),
        ready,
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });

    const result = await Effect.runPromise(Effect.either(
      secureInferenceResponse({
        appVersion: "0.1.0",
        feature: "inference.chatCompletions",
        path: "/v1/chat/completions",
        payload: { messages: [], model: "model_test", stream: true },
        requestId: "req_timeout",
        responseTimeoutMs: 20,
        signal: new AbortController().signal,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({
          read: async () => ({
            email: "user@example.test",
            expiresAt: 1_700_000_000,
            kind: "signed_in",
            sessionToken: "sealed_session_test",
            user: { email: "user@example.test", id: "user_1", name: null },
          }),
        })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    ));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("timed out");
    }
  });

  it("does not abort a slow token stream once response headers have arrived", async () => {
    let streamSignal: AbortSignal | undefined;
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: async (_input, init) => {
          // Headers arrive immediately; capture the signal that governs the body stream.
          streamSignal = init?.signal;
          return new Response("ok");
        },
        ready: async () => {},
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });

    const response = await Effect.runPromise(
      secureInferenceResponse({
        appVersion: "0.1.0",
        feature: "inference.chatCompletions",
        path: "/v1/chat/completions",
        payload: { messages: [], model: "model_test", stream: true },
        requestId: "req_slow_stream",
        responseTimeoutMs: 10,
        signal: new AbortController().signal,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({
          read: async () => ({
            email: "user@example.test",
            expiresAt: 1_700_000_000,
            kind: "signed_in",
            sessionToken: "sealed_session_test",
            user: { email: "user@example.test", id: "user_1", name: null },
          }),
        })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    );

    expect(await response.text()).toBe("ok");
    // Wait well past the response timeout; the body-stream signal must NOT have aborted.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(streamSignal?.aborted).toBe(false);
  });

  it("retries secure fetches that fail with a missing EHBP response nonce header", async () => {
    let attempts = 0;
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Missing Ehbp-Response-Nonce header");
          return new Response("ok");
        },
        ready: async () => {},
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });

    const response = await Effect.runPromise(
      secureInferenceResponse({
        appVersion: "0.1.0",
        feature: "inference.chatCompletions",
        path: "/v1/chat/completions",
        payload: { messages: [], model: "model_test", stream: true },
        requestId: "req_nonce_retry",
        signal: new AbortController().signal,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({
          read: async () => ({
            email: "user@example.test",
            expiresAt: 1_700_000_000,
            kind: "signed_in",
            sessionToken: "sealed_session_test",
            user: { email: "user@example.test", id: "user_1", name: null },
          }),
        })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    );

    expect(await response.text()).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("does not retry secure fetches for non-transient failures", async () => {
    let attempts = 0;
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: async () => {
          attempts += 1;
          throw new Error("attestation mismatch");
        },
        ready: async () => {},
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });

    const result = await Effect.runPromise(Effect.either(
      secureInferenceResponse({
        appVersion: "0.1.0",
        feature: "inference.chatCompletions",
        path: "/v1/chat/completions",
        payload: { messages: [], model: "model_test", stream: true },
        requestId: "req_no_retry",
        signal: new AbortController().signal,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({
          read: async () => ({
            email: "user@example.test",
            expiresAt: 1_700_000_000,
            kind: "signed_in",
            sessionToken: "sealed_session_test",
            user: { email: "user@example.test", id: "user_1", name: null },
          }),
        })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    ));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toBe("Secure request failed: attestation mismatch");
    }
    expect(attempts).toBe(1);
  });

  it("can send native FormData audio transcription bodies without an explicit boundary", async () => {
    const calls: { init?: RequestInit; input?: RequestInfo | URL } = {};
    const secureClient = createBridgeSecureClient({
      makeSecureClient: (() => ({
        fetch: async (input, init) => {
          calls.input = input;
          calls.init = init;
          return new Response("{}");
        },
        ready: async () => {},
      })) satisfies SecureClientFactory,
      serverBaseUrl: "https://api.example.test",
    });
    const body = new FormData();
    body.set("model", "whisper-large-v3-turbo");
    body.set("file", new Blob(["audio bytes"], { type: "audio/wav" }), "sample.wav");

    await Effect.runPromise(
      secureInferenceResponse({
        accept: "application/json",
        appVersion: "0.1.0",
        body,
        contentType: null,
        feature: "inference.audioTranscriptions",
        path: "/v1/audio/transcriptions",
        payload: { model: "whisper-large-v3-turbo" },
        requestId: "req_audio",
        signal: new AbortController().signal,
      }).pipe(
        Effect.provideService(BridgeSessionService, createBridgeSessionService({
          read: async () => ({
            email: "user@example.test",
            expiresAt: 1_700_000_000,
            kind: "signed_in",
            sessionToken: "sealed_session_test",
            user: { email: "user@example.test", id: "user_1", name: null },
          }),
        })),
        Effect.provideService(BridgeSecureClient, secureClient),
        Effect.provideService(BridgeAuditService, createBridgeAuditService(new MemoryAuditSink())),
      ),
    );

    expect(calls.input).toBe("/v1/audio/transcriptions");
    const headers = new Headers(calls.init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("x-ambient-model-id")).toBe("whisper-large-v3-turbo");
    expect(calls.init?.body).toBe(body);
  });
});

function signedInSession(): SignedInWorkOsSession {
  return {
    email: "user@example.test",
    expiresAt: 1_800_000_000,
    kind: "signed_in",
    organizationId: "org_test",
    sessionToken: "sealed_session_test",
    user: { email: "user@example.test", id: "user_1", name: null },
  };
}

function usageService(): BridgeUsageService & {
  readonly reserve: ReturnType<typeof vi.fn<BridgeUsageService["reserve"]>>;
  readonly release: ReturnType<typeof vi.fn<BridgeUsageService["release"]>>;
} {
  const summary: UsageSummary = {
    schemaVersion: 1,
    owner: { kind: "organization", id: "org_test" },
    currency: "USD",
    period: { kind: "lifetime" },
    mode: "metered",
    grantedMicros: "100",
    usedMicros: "0",
    reservedMicros: "60",
    remainingMicros: "40",
    updatedAt: "2026-07-20T12:00:00.000Z",
  };
  const reserve = vi.fn<BridgeUsageService["reserve"]>(() => Effect.succeed({
    reservationId: "crr_test_abcdefghijklmnop",
    reservedMicros: "60",
    expiresAt: "2026-07-20T12:15:00.000Z",
    summary,
  }));
  const release = vi.fn<BridgeUsageService["release"]>(() => Effect.void);
  return { summary: async () => summary, reserve, release };
}
