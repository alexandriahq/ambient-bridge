import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

interface JwtHeader {
  readonly alg: "EdDSA";
  readonly kid: string;
  readonly typ: "JWT";
}

export interface VerifiedJwt {
  readonly header: JwtHeader;
  readonly claims: Record<string, unknown>;
}

export type SigningJwk = JsonWebKey & {
  readonly alg: "EdDSA";
  readonly kid: string;
  readonly use: "sig";
};

export interface VerifyJwtOptions {
  readonly audience?: string;
  readonly issuer?: string;
  readonly nowSeconds?: number;
  readonly clockToleranceSeconds?: number;
}

export class JwtVerificationError extends Error {
  constructor(readonly code: "malformed" | "unsupported" | "invalid_signature" | "expired" | "not_yet_valid" | "claims") {
    super(`JWT verification failed: ${code}.`);
    this.name = "JwtVerificationError";
  }
}

export function signJwt(
  claims: Readonly<Record<string, unknown>>,
  options: { readonly privateKey: string | KeyObject; readonly keyId: string },
): string {
  const header: JwtHeader = { alg: "EdDSA", kid: options.keyId, typ: "JWT" };
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = sign(null, Buffer.from(signingInput), normalizePrivateKey(options.privateKey));
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function verifyJwt(
  token: string,
  resolvePublicKey: (keyId: string) => string | KeyObject | JsonWebKey | null,
  options: VerifyJwtOptions = {},
): VerifiedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtVerificationError("malformed");
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  let header: JwtHeader;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(encodedHeader!, "base64url").toString("utf8")) as JwtHeader;
    claims = JSON.parse(Buffer.from(encodedClaims!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new JwtVerificationError("malformed");
  }
  if (header.alg !== "EdDSA" || header.typ !== "JWT" || typeof header.kid !== "string") {
    throw new JwtVerificationError("unsupported");
  }
  const key = resolvePublicKey(header.kid);
  if (!key) throw new JwtVerificationError("invalid_signature");
  const valid = verify(
    null,
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    normalizePublicKey(key),
    Buffer.from(encodedSignature!, "base64url"),
  );
  if (!valid) throw new JwtVerificationError("invalid_signature");

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const tolerance = options.clockToleranceSeconds ?? 0;
  if (typeof claims.exp !== "number" || claims.exp <= now - tolerance) {
    throw new JwtVerificationError("expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + tolerance) {
    throw new JwtVerificationError("not_yet_valid");
  }
  if (options.issuer !== undefined && claims.iss !== options.issuer) {
    throw new JwtVerificationError("claims");
  }
  if (options.audience !== undefined && claims.aud !== options.audience) {
    throw new JwtVerificationError("claims");
  }
  return { header, claims };
}

export function publicJwk(input: { readonly privateKey: string | KeyObject; readonly keyId: string }): SigningJwk {
  const key = createPublicKey(normalizePrivateKey(input.privateKey));
  return {
    ...key.export({ format: "jwk" }),
    alg: "EdDSA",
    kid: input.keyId,
    use: "sig",
  } as SigningJwk;
}

export function generateEd25519KeyPairPem(): { readonly privateKey: string; readonly publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function normalizePrivateKey(value: string | KeyObject): KeyObject {
  return typeof value === "string" ? createPrivateKey(value) : value;
}

function normalizePublicKey(value: string | KeyObject | JsonWebKey): KeyObject {
  if (typeof value === "string") return createPublicKey(value);
  if ("type" in value) return value;
  return createPublicKey({ format: "jwk", key: value });
}
