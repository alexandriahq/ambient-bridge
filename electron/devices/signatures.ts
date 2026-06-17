import { createHash } from "node:crypto";
import { signDevicePayload, type DeviceIdentity } from "./identity.js";

export type DeviceSignedRequest = {
  requestId: string;
  timestamp: number;
  bodyHash: string;
  signature: string;
};

export function signServerRequest(input: {
  identity: DeviceIdentity;
  method: string;
  path: string;
  body: string;
  requestId: string;
  timestamp?: number;
}): DeviceSignedRequest {
  const timestamp = input.timestamp ?? Date.now();
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  const payload = [input.method, input.path, input.requestId, String(timestamp), bodyHash].join("\n");
  const signature = signDevicePayload(input.identity, payload);
  return { bodyHash, requestId: input.requestId, signature, timestamp };
}
