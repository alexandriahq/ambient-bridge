import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { EncryptedSessionStore, type TokenCrypto } from "../electron/workos/token-store.js";
import type { SignedInWorkOsSession } from "../electron/workos/session.js";
import { SessionRefreshCoordinator } from "../electron/session-refresh-coordinator.js";

// Covers the persisted-session/refresh seam, not Electron startup or OS encryption.
test("a cold store reload exposes the saved account before cloud refresh and preserves it offline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ambient-cold-session-"));
  const file = path.join(root, "session.enc");
  const crypto: TokenCrypto = {
    decryptString: (value) => value.toString("utf8"),
    encryptString: (value) => Buffer.from(value, "utf8"),
    isEncryptionAvailable: () => true,
  };
  const saved: SignedInWorkOsSession = {
    kind: "signed_in", email: "offline@example.test", expiresAt: 1_800_000_000,
    sessionToken: "isolated-test-session", user: { id: "offline-user", email: "offline@example.test", name: "Offline User" },
  };
  let coordinator: SessionRefreshCoordinator<SignedInWorkOsSession> | undefined;
  try {
    await new EncryptedSessionStore(file, crypto).write(saved);
    // A new instance has no in-memory session, just the preceding launch's file.
    const restarted = new EncryptedSessionStore(file, crypto);
    expect(restarted.peekCached()).toBeNull();
    let rejectCloud!: (error: Error) => void;
    const cloud = new Promise<void>((_resolve, reject) => { rejectCloud = reject; });
    let started!: () => void;
    const cloudStarted = new Promise<void>((resolve) => { started = resolve; });
    const refresh = vi.fn(async () => { started(); await cloud; });
    coordinator = new SessionRefreshCoordinator({
      readSession: async () => { const session = await restarted.read(); return session.kind === "signed_in" ? session : null; },
      refreshSession: refresh,
      errorMessage: (error) => String(error),
      policy: { baseDelayMs: 10, maxAttempts: 2, maxDelayMs: 10, recoveryDelayMs: 60_000 },
      sleep: async () => undefined,
    });
    const pending = coordinator.refresh("cold_start");
    await cloudStarted;
    expect(coordinator.snapshot().state).toBe("refreshing");
    await expect(restarted.read()).resolves.toEqual(saved);
    expect(restarted.peekCached()).toEqual(saved);

    rejectCloud(new Error("Internet unavailable"));
    await pending;
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot().state).toBe("degraded");
    await expect(new EncryptedSessionStore(file, crypto).read()).resolves.toEqual(saved);

    refresh.mockImplementation(async () => {});
    await coordinator.refresh("network_restored");
    expect(coordinator.snapshot().state).toBe("ready");
    await expect(restarted.read()).resolves.toEqual(saved);
    // Explicit logout is different: it must survive another cold restart.
    await restarted.clear();
    await expect(new EncryptedSessionStore(file, crypto).read()).resolves.toEqual({ kind: "signed_out" });
  } finally {
    coordinator?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
