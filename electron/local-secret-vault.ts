import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Payload layout: MAGIC | 12-byte IV | 16-byte GCM tag | ciphertext.
const VAULT_PAYLOAD_MAGIC = Buffer.from("AMBVAULT1");
const KEY_FILE_VERSION = 1;
const KEY_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 12;
const AUTH_TAG_BYTE_LENGTH = 16;

/**
 * Prompt-free secret encryption backed by a per-install key file instead of the
 * OS keychain. Electron's safeStorage keeps its key in the login keychain with
 * an ACL bound to the app's code signature; every unsigned/ad-hoc build is a
 * "different app" to that ACL, so macOS interrupts launch with a password
 * prompt. This vault trades the keychain ACL for a 0600 key file next to the
 * app's data: same protection class as the data it wraps (user-level file
 * permissions + full-disk encryption), but silent on every build.
 *
 * The API is shape-compatible with Electron's safeStorage so stores accepting
 * a { isEncryptionAvailable, encryptString, decryptString } crypto can swap
 * back to the keychain if signed builds ever make it silent again.
 */
export class LocalSecretVault {
  #key: Buffer | null = null;

  constructor(private readonly keyFilePath: string) {}

  isEncryptionAvailable(): boolean {
    try {
      this.#ensureKey();
      return true;
    } catch {
      return false;
    }
  }

  encryptString(value: string): Buffer {
    const key = this.#ensureKey();
    const iv = randomBytes(IV_BYTE_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([VAULT_PAYLOAD_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  }

  decryptString(payload: Buffer): string {
    if (!isLocalVaultPayload(payload)) {
      throw new Error("Payload was not produced by the local secret vault.");
    }
    const key = this.#ensureKey();
    const ivStart = VAULT_PAYLOAD_MAGIC.length;
    const tagStart = ivStart + IV_BYTE_LENGTH;
    const ciphertextStart = tagStart + AUTH_TAG_BYTE_LENGTH;
    const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(ivStart, tagStart));
    decipher.setAuthTag(payload.subarray(tagStart, ciphertextStart));
    return Buffer.concat([decipher.update(payload.subarray(ciphertextStart)), decipher.final()]).toString("utf8");
  }

  #ensureKey(): Buffer {
    if (this.#key) return this.#key;

    try {
      const parsed = JSON.parse(readFileSync(this.keyFilePath, "utf8")) as { version?: unknown; keyBase64?: unknown };
      if (parsed.version === KEY_FILE_VERSION && typeof parsed.keyBase64 === "string") {
        const key = Buffer.from(parsed.keyBase64, "base64");
        if (key.byteLength === KEY_BYTE_LENGTH) {
          this.#key = key;
          return key;
        }
      }
      throw new Error(`Local secret vault key file is invalid: ${this.keyFilePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const key = randomBytes(KEY_BYTE_LENGTH);
    mkdirSync(dirname(this.keyFilePath), { recursive: true });
    const tempPath = `${this.keyFilePath}.tmp-${process.pid}`;
    writeFileSync(tempPath, `${JSON.stringify({ keyBase64: key.toString("base64"), version: KEY_FILE_VERSION })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tempPath, this.keyFilePath);
    this.#key = key;
    return key;
  }
}

export function isLocalVaultPayload(payload: Buffer): boolean {
  return payload.byteLength >= VAULT_PAYLOAD_MAGIC.length + IV_BYTE_LENGTH + AUTH_TAG_BYTE_LENGTH
    && payload.subarray(0, VAULT_PAYLOAD_MAGIC.length).equals(VAULT_PAYLOAD_MAGIC);
}
