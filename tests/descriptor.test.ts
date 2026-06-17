import { describe, expect, it } from "vitest";
import { createDeviceIdentity } from "../electron/devices/identity.js";
import { signDescriptor, verifyDescriptor } from "../electron/ipc-server/descriptor.js";

describe("Bridge descriptor", () => {
  it("is signed by the Bridge device identity", () => {
    const identity = createDeviceIdentity();
    const descriptor = signDescriptor(
      {
        instanceId: "instance_1",
        pid: 123,
        publicPairingKey: identity.publicKeyPem,
        socketPath: "/tmp/ambient-bridge.sock",
        version: "0.0.0",
      },
      identity.privateKeyPem,
    );

    expect(verifyDescriptor(descriptor, identity.publicKeyPem)).toBe(true);
    expect(verifyDescriptor({ ...descriptor, socketPath: "/tmp/tampered.sock" }, identity.publicKeyPem)).toBe(false);
  });
});
