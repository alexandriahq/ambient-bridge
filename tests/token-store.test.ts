import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { EncryptedSessionStore, type TokenCrypto } from "../electron/workos/token-store.js";
import type { WorkOsSession } from "../electron/workos/session.js";

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
});
