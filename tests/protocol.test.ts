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
});
