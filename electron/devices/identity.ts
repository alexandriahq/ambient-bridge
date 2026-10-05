import { createHash, generateKeyPairSync } from "node:crypto";

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
