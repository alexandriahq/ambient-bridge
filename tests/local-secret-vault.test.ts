import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLocalVaultPayload, LocalSecretVault } from "../electron/local-secret-vault.js";
import { EncryptedSessionStore } from "../electron/workos/token-store.js";

describe("LocalSecretVault", () => {
  let dir: string;
  let keyFilePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ambient-vault-"));
    keyFilePath = join(dir, "nested", "vault-key.json");
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("round-trips secrets", () => {
    const vault = new LocalSecretVault(keyFilePath);
    const payload = vault.encryptString("hello secrets");
    expect(isLocalVaultPayload(payload)).toBe(true);
    expect(vault.decryptString(payload)).toBe("hello secrets");
  });

  it.skipIf(process.platform === "win32").each(["permissions", "symlink"])("preserves the existing Bridge key-file behavior for %s", (kind) => {
    // Characterize the existing hardening gap during extraction; future hardening may change it.
    mkdirSync(join(dir, "nested"));
    const target = kind === "symlink" ? join(dir, "target.json") : keyFilePath;
    writeFileSync(target, JSON.stringify({ version: 1, keyBase64: Buffer.alloc(32, 7).toString("base64") }), { mode: 0o600 });
    if (kind === "symlink") symlinkSync(target, keyFilePath);
    else chmodSync(keyFilePath, 0o644);
    const vault = new LocalSecretVault(keyFilePath);
    expect(vault.decryptString(vault.encryptString("existing session"))).toBe("existing session");
  });

  it("reopens a real sealed session and signs out when its ciphertext or key changes", async () => {
    const sessionPath = join(dir, "workos-session.enc");
    const store = (keyPath = keyFilePath) => new EncryptedSessionStore(sessionPath, new LocalSecretVault(keyPath));
    const session = { kind: "signed_in" as const, email: "user@example.test", expiresAt: 1_700_000_000, sessionToken: "synthetic-session", user: { id: "test-user", email: "user@example.test", name: "Test" } };
    await store().write(session);
    expect(await store().read()).toEqual(session);
    expect(await store(join(dir, "wrong-key.json")).read()).toEqual({ kind: "signed_out" });
    const payload = readFileSync(sessionPath);
    payload[payload.length - 1] ^= 1;
    writeFileSync(sessionPath, payload);
    expect(await store().read()).toEqual({ kind: "signed_out" });
  });

  it("creates the key file lazily with owner-only permissions", () => {
    const vault = new LocalSecretVault(keyFilePath);
    expect(vault.isEncryptionAvailable()).toBe(true);
    // Windows has no POSIX modes (chmod is a no-op there); ACLs default to
    // the owning user for %APPDATA%-style locations.
    if (process.platform !== "win32") {
      const mode = statSync(keyFilePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    const parsed = JSON.parse(readFileSync(keyFilePath, "utf8")) as { version: number; keyBase64: string };
    expect(parsed.version).toBe(1);
    expect(Buffer.from(parsed.keyBase64, "base64").byteLength).toBe(32);
  });

  it("decrypts across instances via the persisted key file", () => {
    const payload = new LocalSecretVault(keyFilePath).encryptString("survives restarts");
    expect(new LocalSecretVault(keyFilePath).decryptString(payload)).toBe("survives restarts");
  });

  it("rejects payloads from other formats (e.g. legacy safeStorage)", () => {
    const vault = new LocalSecretVault(keyFilePath);
    expect(() => vault.decryptString(Buffer.from("v10legacy-safe-storage-bytes"))).toThrow(
      /not produced by the local secret vault/,
    );
  });

  it("rejects tampered payloads", () => {
    const vault = new LocalSecretVault(keyFilePath);
    const payload = vault.encryptString("integrity matters");
    payload[payload.byteLength - 1] ^= 0xff;
    expect(() => vault.decryptString(payload)).toThrow();
  });

  it("rejects payloads sealed with a different key", () => {
    const payload = new LocalSecretVault(join(dir, "other-key.json")).encryptString("wrong key");
    expect(() => new LocalSecretVault(keyFilePath).decryptString(payload)).toThrow();
  });
});
