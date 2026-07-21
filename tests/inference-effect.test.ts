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
