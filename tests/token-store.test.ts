import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { EncryptedSessionStore, type TokenCrypto } from "../electron/workos/token-store.js";
import type { SignedInWorkOsSession, WorkOsSession } from "../electron/workos/session.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
  };
});

describe("EncryptedSessionStore", () => {
  test("caches decrypted WorkOS sessions after the first read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ambient-bridge-token-store-"));
    let decryptCalls = 0;
    const crypto: TokenCrypto = {
      decryptString: (value) => {
        decryptCalls += 1;
        return value.toString("utf8");
      },
      encryptString: (value) => Buffer.from(value, "utf8"),
      isEncryptionAvailable: () => true,
    };
    const store = new EncryptedSessionStore(path.join(root, "workos-session.enc"), crypto);
    const session: WorkOsSession = {
      email: "user@example.test",
      expiresAt: 1_700_000_000_000,
      kind: "signed_in",
      sessionToken: "sealed_session_test",
      user: {
        email: "user@example.test",
        id: "user_1",
        name: "User",
      },
    };

    try {
      await store.write(session);
      expect(await store.read()).toEqual(session);
      expect(await store.read()).toEqual(session);
      expect(decryptCalls).toBe(0);

      const reloaded = new EncryptedSessionStore(path.join(root, "workos-session.enc"), crypto);
      expect(await Promise.all([reloaded.read(), reloaded.read()])).toEqual([session, session]);
      expect(decryptCalls).toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("retains a replacement session when a stale request tries to clear its predecessor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ambient-bridge-token-store-"));
    const crypto: TokenCrypto = {
      decryptString: (value) => value.toString("utf8"),
      encryptString: (value) => Buffer.from(value, "utf8"),
      isEncryptionAvailable: () => true,
    };
    const store = new EncryptedSessionStore(path.join(root, "workos-session.enc"), crypto);
    const original: SignedInWorkOsSession = {
      email: "user@example.test",
      expiresAt: 1_700_000_000,
      kind: "signed_in",
      sessionToken: "sealed_session_t1",
      user: { email: "user@example.test", id: "user_1", name: "User" },
    };
    const replacement: SignedInWorkOsSession = {
      ...original,
      expiresAt: 1_800_000_000,
      sessionToken: "sealed_session_t2",
    };

    try {
      await store.write(original);
      await store.write(replacement);

      await expect(store.clearIfCurrent(original)).resolves.toBe(false);
      await expect(store.read()).resolves.toEqual(replacement);

      await expect(store.clearIfCurrent(replacement)).resolves.toBe(true);
      await expect(store.read()).resolves.toEqual({ kind: "signed_out" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("serializes stale clearing behind an in-flight replacement write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ambient-bridge-token-store-"));
    const crypto: TokenCrypto = {
      decryptString: (value) => value.toString("utf8"),
      encryptString: (value) => Buffer.from(value, "utf8"),
      isEncryptionAvailable: () => true,
    };
    const store = new EncryptedSessionStore(path.join(root, "workos-session.enc"), crypto);
    const original: SignedInWorkOsSession = {
      email: "user@example.test",
      expiresAt: 1_700_000_000,
      kind: "signed_in",
      sessionToken: "sealed_session_t1",
      user: { email: "user@example.test", id: "user_1", name: "User" },
    };
    const replacement: SignedInWorkOsSession = {
      ...original,
      expiresAt: 1_800_000_000,
      sessionToken: "sealed_session_t2",
    };
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let releaseWrite = () => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let announceWriteStarted = () => undefined;
    const writeStarted = new Promise<void>((resolve) => {
      announceWriteStarted = resolve;
    });
    try {
      await store.write(original);
      vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
        announceWriteStarted();
        await writeGate;
        await actual.writeFile(...args);
      });
      const replacementWrite = store.write(replacement);
      await writeStarted;

      const staleClear = store.clearIfCurrent(original);
      let staleClearSettled = false;
      void staleClear.then(() => {
        staleClearSettled = true;
      });
      await Promise.resolve();
      expect(staleClearSettled).toBe(false);

      releaseWrite();
      await replacementWrite;
      await expect(staleClear).resolves.toBe(false);
      await expect(store.read()).resolves.toEqual(replacement);
    } finally {
      releaseWrite();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("keeps compare-and-write atomic against a stale clear", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ambient-bridge-token-store-"));
    const crypto: TokenCrypto = {
      decryptString: (value) => value.toString("utf8"),
      encryptString: (value) => Buffer.from(value, "utf8"),
      isEncryptionAvailable: () => true,
    };
    const store = new EncryptedSessionStore(path.join(root, "workos-session.enc"), crypto);
    const original: SignedInWorkOsSession = {
      email: "user@example.test",
      expiresAt: 1_700_000_000,
      kind: "signed_in",
      sessionToken: "sealed_session_t1",
      user: { email: "user@example.test", id: "user_1", name: "User" },
    };
    const replacement: SignedInWorkOsSession = {
      ...original,
      expiresAt: 1_800_000_000,
      sessionToken: "sealed_session_t2",
    };
    const signOutPublished = vi.fn();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let releaseWrite = () => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let announceWriteStarted = () => undefined;
    const writeStarted = new Promise<void>((resolve) => {
      announceWriteStarted = resolve;
    });

    try {
      await store.write(original);
      vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
        announceWriteStarted();
        await writeGate;
        await actual.writeFile(...args);
      });

      const replacementWrite = store.writeIfCurrent(replacement, original);
      await writeStarted;
      const staleClear = store.clearIfCurrent(original).then((cleared) => {
        if (cleared) signOutPublished();
        return cleared;
      });

      await Promise.resolve();
      await expect(store.read()).resolves.toEqual(original);
      expect(signOutPublished).not.toHaveBeenCalled();

      releaseWrite();
      await expect(replacementWrite).resolves.toBe("written");
      await expect(staleClear).resolves.toBe(false);
      await expect(store.read()).resolves.toEqual(replacement);
      expect(signOutPublished).not.toHaveBeenCalled();
    } finally {
      releaseWrite();
      await rm(root, { force: true, recursive: true });
    }
  });
});
