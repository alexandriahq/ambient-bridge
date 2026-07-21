import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, type BridgeFrame } from "../electron/ipc-server/protocol.js";

describe("IPC protocol framing", () => {
  it("round-trips length-prefixed frames split across chunks", () => {
    const frame: BridgeFrame = {
      id: "req_1",
      method: "bridge.health",
      payload: { ping: true },
      type: "request",
    };

    const encoded = encodeFrame(frame);
    const decoder = new FrameDecoder();
    const first = decoder.push(encoded.subarray(0, 5));
    const second = decoder.push(encoded.subarray(5));

    expect(first).toEqual([]);
    expect(second).toEqual([frame]);
  });

  it("round-trips stream frames", () => {
    const frame: BridgeFrame = {
      event: "delta",
      id: "req_1",
      payload: { chunk: "hello" },
      type: "stream",
    };

    const decoder = new FrameDecoder();

    expect(decoder.push(encodeFrame(frame))).toEqual([frame]);
  });

  it("rejects malformed frames before they reach handlers", () => {
    const missingMethod = { id: "req_1", type: "request" };
    const invalidStreamEvent = { event: "sideways", id: "req_2", type: "stream" };
    const invalidAuth = {
      auth: { bodyHash: "hash", credentialId: "cred", nonce: "nonce", signature: "sig", timestamp: "soon" },
      id: "req_3",
      method: "bridge.status",
      type: "request",
    };

    for (const frame of [missingMethod, invalidStreamEvent, invalidAuth]) {
      const decoder = new FrameDecoder();
      expect(() => decoder.push(encodeFrame(frame as never))).toThrow(/Invalid IPC frame/);
    }
  });

  it("rejects frames above the decoder byte limit", () => {
    const decoder = new FrameDecoder(16);
    const frame: BridgeFrame = {
      id: "req_large",
      method: "bridge.health",
      payload: { message: "this frame is intentionally too large" },
      type: "request",
    };

    expect(() => decoder.push(encodeFrame(frame))).toThrow(/IPC frame exceeds 16 bytes/);
  });
});
