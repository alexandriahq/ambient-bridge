import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { BridgeRequestAuth, JsonValue } from "./protocol.js";

export type LocalCredential = {
  id: string;
  secret: string;
  revokedAt?: number;
};

export type LocalAuthFailure =
  | "missing_auth"
  | "unknown_credential"
  | "revoked_credential"
  | "stale_timestamp"
  | "replayed_nonce"
  | "body_hash_mismatch"
  | "signature_mismatch";

export type LocalAuthResult =
  | { ok: true; credentialId: string }
  | { ok: false; reason: LocalAuthFailure };

export type VerifyLocalRequestInput = {
  auth?: BridgeRequestAuth;
  credential?: LocalCredential;
  method: string;
  payload?: JsonValue;
  now?: number;
  replayCache: ReplayCache;
};

const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function hashPayload(payload: JsonValue | undefined): string {
  const body = JSON.stringify(payload ?? null);
  return createHash("sha256").update(body).digest("hex");
}

export function canonicalAuthMessage(input: {
  method: string;
  timestamp: number;
  nonce: string;
  bodyHash: string;
}): string {
  return [input.method, String(input.timestamp), input.nonce, input.bodyHash].join("\n");
}

export function signLocalRequest(input: {
  credential: LocalCredential;
  method: string;
  payload?: JsonValue;
  timestamp?: number;
  nonce: string;
}): BridgeRequestAuth {
  const bodyHash = hashPayload(input.payload);
  const timestamp = input.timestamp ?? Date.now();
  const message = canonicalAuthMessage({
    bodyHash,
    method: input.method,
    nonce: input.nonce,
    timestamp,
  });
  const signature = createHmac("sha256", input.credential.secret).update(message).digest("hex");

  return {
    bodyHash,
    credentialId: input.credential.id,
    nonce: input.nonce,
    signature,
    timestamp,
  };
}

export function verifyLocalRequest(input: VerifyLocalRequestInput): LocalAuthResult {
  const { auth, credential, method, payload, replayCache } = input;
  const now = input.now ?? Date.now();

  if (!auth) {
    return { ok: false, reason: "missing_auth" };
  }

  if (!credential) {
    return { ok: false, reason: "unknown_credential" };
  }

  if (credential.revokedAt) {
    return { ok: false, reason: "revoked_credential" };
  }

  if (
    typeof auth.credentialId !== "string" ||
    typeof auth.nonce !== "string" ||
    typeof auth.bodyHash !== "string" ||
    typeof auth.signature !== "string"
  ) {
    return { ok: false, reason: "signature_mismatch" };
  }

  if (typeof auth.timestamp !== "number" || !Number.isFinite(auth.timestamp)) {
    return { ok: false, reason: "stale_timestamp" };
  }

  if (Math.abs(now - auth.timestamp) > DEFAULT_CLOCK_SKEW_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  if (replayCache.has(auth.credentialId, auth.nonce, now)) {
    return { ok: false, reason: "replayed_nonce" };
  }

  const bodyHash = hashPayload(payload);
  if (auth.bodyHash !== bodyHash) {
    return { ok: false, reason: "body_hash_mismatch" };
  }

  const message = canonicalAuthMessage({
    bodyHash,
    method,
    nonce: auth.nonce,
    timestamp: auth.timestamp,
  });
  const expected = createHmac("sha256", credential.secret).update(message).digest("hex");

  if (!safeEqualHex(expected, auth.signature)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  replayCache.remember(auth.credentialId, auth.nonce, auth.timestamp);
  return { ok: true, credentialId: credential.id };
}

export class ReplayCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = DEFAULT_CLOCK_SKEW_MS) {}

  has(credentialId: string, nonce: string, now = Date.now()): boolean {
    this.prune(now);
    return this.seen.has(this.key(credentialId, nonce));
  }

  remember(credentialId: string, nonce: string, timestamp: number): void {
    this.seen.set(this.key(credentialId, nonce), timestamp);
  }

  private prune(now: number): void {
    for (const [key, timestamp] of this.seen.entries()) {
      if (now - timestamp > this.ttlMs) {
        this.seen.delete(key);
      }
    }
  }

  private key(credentialId: string, nonce: string): string {
    return `${credentialId}:${nonce}`;
  }
}

function safeEqualHex(left: string, right: string): boolean {
  if (!isHexString(left) || !isHexString(right)) {
    return false;
  }
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isHexString(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[\da-f]+$/i.test(value);
}
