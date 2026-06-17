import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sign, verify } from "node:crypto";

export type BridgeDescriptorFields = {
  socketPath: string;
  pid: number;
  version: string;
  instanceId: string;
  publicPairingKey: string;
};

export type BridgeDescriptor = BridgeDescriptorFields & {
  descriptorSignature: string;
};

export function signDescriptor(
  fields: BridgeDescriptorFields,
  privateKeyPem: string,
): BridgeDescriptor {
  const payload = canonicalDescriptorPayload(fields);
  const descriptorSignature = sign(null, Buffer.from(payload), privateKeyPem).toString("base64");
  return { ...fields, descriptorSignature };
}

export function verifyDescriptor(descriptor: BridgeDescriptor, publicKeyPem: string): boolean {
  const payload = canonicalDescriptorPayload(descriptor);
  return verify(
    null,
    Buffer.from(payload),
    publicKeyPem,
    Buffer.from(descriptor.descriptorSignature, "base64"),
  );
}

export async function writeDescriptorFile(path: string, descriptor: BridgeDescriptor): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, path);
}

export function canonicalDescriptorPayload(fields: BridgeDescriptorFields): string {
  return JSON.stringify({
    instanceId: fields.instanceId,
    pid: fields.pid,
    publicPairingKey: fields.publicPairingKey,
    socketPath: fields.socketPath,
    version: fields.version,
  });
}
