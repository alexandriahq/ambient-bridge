import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

export type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

export function createDeviceIdentity(): DeviceIdentity {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const privateKeyPem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const deviceId = createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 32);
  return { deviceId, privateKeyPem, publicKeyPem };
}

export function signDevicePayload(identity: DeviceIdentity, payload: string): string {
  return sign(null, Buffer.from(payload), identity.privateKeyPem).toString("base64");
}

export function verifyDevicePayload(publicKeyPem: string, payload: string, signature: string): boolean {
  return verify(null, Buffer.from(payload), publicKeyPem, Buffer.from(signature, "base64"));
}
