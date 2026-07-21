import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLocalVaultPayload, LocalSecretVault } from "../electron/local-secret-vault.js";

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
