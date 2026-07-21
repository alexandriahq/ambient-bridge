import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthServerRequestError } from "../electron/auth/server-client.js";
import {
  SessionRefreshCoordinator,
  isAuthProviderUnavailableError,
  isDefinitiveSessionRejection,
  resolveSessionRefreshFailure,
  sessionRefreshConnectionState,
  sessionRefreshDelayMs,
  type SessionRefreshSnapshot,
} from "../electron/session-refresh-coordinator.js";

describe("sessionRefreshDelayMs", () => {
  it("uses bounded exponential backoff", () => {
    const policy = { baseDelayMs: 2_000, maxDelayMs: 8_000 };

    expect([1, 2, 3, 4, 5].map((attempt) => sessionRefreshDelayMs(attempt, policy)))
      .toEqual([2_000, 4_000, 8_000, 8_000, 8_000]);
  });
});

describe("sessionRefreshConnectionState", () => {
  it.each([
    ["ready", "ready"],
    ["refreshing", "retrying"],
    ["retrying", "retrying"],
    ["degraded", "degraded"],
  ] as const)("maps %s health to %s connection status", (state, expected) => {
    expect(sessionRefreshConnectionState({
      attempt: state === "ready" ? 0 : 1,
      message: null,
      nextRetryAt: null,
      state,
    })).toBe(expected);
  });
});

describe("resolveSessionRefreshFailure", () => {
  it("clears only a definitive 401 and preserves provider-unavailable auth", async () => {
    const clearSession = vi.fn(async () => true);
    const options = {
      clearSession,
      isDefinitiveRejection: isDefinitiveSessionRejection,
    };
    const providerUnavailable = new AuthServerRequestError(503, "Auth provider unavailable");
    const unauthorized = new AuthServerRequestError(401, "Unauthorized");

    expect(isAuthProviderUnavailableError(providerUnavailable)).toBe(true);
    expect(isDefinitiveSessionRejection(providerUnavailable)).toBe(false);
    await expect(resolveSessionRefreshFailure(providerUnavailable, options)).resolves.toBe("retry");
    expect(clearSession).not.toHaveBeenCalled();

    expect(isDefinitiveSessionRejection(unauthorized)).toBe(true);
    expect(isAuthProviderUnavailableError(unauthorized)).toBe(false);
    await expect(resolveSessionRefreshFailure(unauthorized, options)).resolves.toBe("signed_out");
    expect(clearSession).toHaveBeenCalledOnce();
    expect(clearSession).toHaveBeenCalledWith(unauthorized);
  });

  it("reports a definitive rejection as stale when its session no longer matches", async () => {
    const unauthorized = new AuthServerRequestError(401, "Unauthorized");

    await expect(resolveSessionRefreshFailure(unauthorized, {
      clearSession: async () => false,
      isDefinitiveRejection: isDefinitiveSessionRejection,
    })).resolves.toBe("stale");
  });
});

describe("SessionRefreshCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the cached session after five provider-unavailable responses", async () => {
    const session = { id: "cached-session" };
    const snapshots: SessionRefreshSnapshot[] = [];
    const readSession = vi.fn(async () => session);
    const refreshSession = vi.fn(async () => {
      throw new Error("Auth provider unavailable (503)");
    });

    const coordinator = new SessionRefreshCoordinator({
      errorMessage: (error) => error instanceof Error ? error.message : String(error),
      onStateChange: (snapshot) => snapshots.push(snapshot),
      policy: {
        baseDelayMs: 2_000,
        maxAttempts: 5,
        maxDelayMs: 30_000,
        recoveryDelayMs: 30_000,
      },
      readSession,
      refreshSession,
      sleep: async () => undefined,
    });

    await coordinator.refresh("test_provider_unavailable");

    expect(readSession).toHaveBeenCalledTimes(5);
    expect(refreshSession).toHaveBeenCalledTimes(5);
    expect(refreshSession).toHaveBeenNthCalledWith(5, session);
    expect(coordinator.snapshot()).toEqual({
      attempt: 5,
      message: "Auth provider unavailable (503)",
      nextRetryAt: expect.any(Number),
      state: "degraded",
    });
    expect(snapshots.map((snapshot) => snapshot.state)).not.toContain("signed_out");
  });

  it("self-heals after a degraded recovery delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const refreshSession = vi.fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockRejectedValueOnce(new Error("503"))
      .mockRejectedValueOnce(new Error("503"))
      .mockRejectedValueOnce(new Error("503"))
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce(undefined);
    const coordinator = new SessionRefreshCoordinator({
      errorMessage: (error) => error instanceof Error ? error.message : String(error),
      policy: {
        baseDelayMs: 2_000,
        maxAttempts: 5,
        maxDelayMs: 30_000,
        recoveryDelayMs: 30_000,
      },
      readSession: async () => ({ id: "cached-session" }),
      refreshSession,
      sleep: async () => undefined,
    });

    await coordinator.refresh("test_provider_unavailable");
    expect(coordinator.snapshot()).toMatchObject({
      nextRetryAt: 1_700_000_030_000,
      state: "degraded",
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(refreshSession).toHaveBeenCalledTimes(6);
    expect(coordinator.snapshot()).toEqual({
      attempt: 0,
      message: null,
      nextRetryAt: null,
      state: "ready",
    });
  });

  it("does not cancel degraded recovery when an overlapping trigger joins the active cycle", async () => {
    vi.useFakeTimers();
    const refreshSession = vi.fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce(undefined);
    let coordinator: SessionRefreshCoordinator<{ id: string }>;
    coordinator = new SessionRefreshCoordinator({
      errorMessage: (error) => error instanceof Error ? error.message : String(error),
      onStateChange: (snapshot) => {
        if (snapshot.state === "degraded") void coordinator.refresh("overlapping_status_trigger");
      },
      policy: {
        baseDelayMs: 1_000,
        maxAttempts: 1,
        maxDelayMs: 1_000,
        recoveryDelayMs: 1_000,
      },
      readSession: async () => ({ id: "cached-session" }),
      refreshSession,
    });

    await coordinator.refresh("initial");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(refreshSession).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot().state).toBe("ready");
  });

  it("publishes ready immediately when a direct refresh succeeds while degraded", async () => {
    vi.useFakeTimers();
    const refreshSession = vi.fn(async () => {
      throw new Error("503");
    });
    const coordinator = new SessionRefreshCoordinator({
      errorMessage: (error) => error instanceof Error ? error.message : String(error),
      policy: {
        baseDelayMs: 1_000,
        maxAttempts: 1,
        maxDelayMs: 1_000,
        recoveryDelayMs: 30_000,
      },
      readSession: async () => ({ id: "cached-session" }),
      refreshSession,
    });

    await coordinator.refresh("initial");
    expect(coordinator.snapshot().state).toBe("degraded");

    coordinator.markReady();

    expect(coordinator.snapshot()).toEqual({
      attempt: 0,
      message: null,
      nextRetryAt: null,
      state: "ready",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshSession).toHaveBeenCalledOnce();
  });

  it("schedules one recovery cycle for repeated direct transient failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const onRetryScheduled = vi.fn();
    const refreshSession = vi.fn(async () => undefined);
    const coordinator = new SessionRefreshCoordinator({
      errorMessage: (error) => error instanceof Error ? error.message : String(error),
      onRetryScheduled,
      policy: {
        baseDelayMs: 2_000,
        maxAttempts: 5,
        maxDelayMs: 30_000,
        recoveryDelayMs: 30_000,
      },
      readSession: async () => ({ id: "cached-session" }),
      refreshSession,
    });
    const unavailable = new Error("Auth provider unavailable (503)");

    coordinator.noteTransientFailure(unavailable, "forced_status");
    coordinator.noteTransientFailure(unavailable, "inference");

    expect(coordinator.snapshot()).toEqual({
      attempt: 1,
      message: "Auth provider unavailable (503)",
      nextRetryAt: 1_700_000_002_000,
      state: "retrying",
    });
    expect(onRetryScheduled).toHaveBeenCalledOnce();
    expect(refreshSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(refreshSession).toHaveBeenCalledOnce();
    expect(coordinator.snapshot().state).toBe("ready");
  });

  it("cancels a pending recovery when disposed", async () => {
    vi.useFakeTimers();
    const refreshSession = vi.fn(async () => undefined);
    const coordinator = new SessionRefreshCoordinator({
      errorMessage: (error) => error instanceof Error ? error.message : String(error),
      policy: {
        baseDelayMs: 1_000,
        maxAttempts: 1,
        maxDelayMs: 1_000,
        recoveryDelayMs: 1_000,
      },
      readSession: async () => ({ id: "cached-session" }),
      refreshSession,
    });

    coordinator.noteTransientFailure(new Error("503"), "forced_status");
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(refreshSession).not.toHaveBeenCalled();
  });
});
