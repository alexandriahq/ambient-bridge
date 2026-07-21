import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_COPY_WIRE_PAYLOAD_CHANNEL,
  BRIDGE_GET_WIRE_CAPTURE_CHANNEL,
  registerBridgeWireCaptureIpc,
} from "../electron/bridge-ui-ipc.js";
import type { BridgeWireCapture, BridgeWireCaptureResult } from "../electron/bridge-ui-contract.js";

function capture(truncated = false): BridgeWireCapture {
  return {
    at: 1,
    requestId: "req-1",
    request: {
      body: { base64: "AQIDBA==", byteLength: truncated ? 10 : 4, capturedBytes: 4, truncated },
      headers: [],
      method: "POST",
      url: "https://api.alexandria.so/v1/responses",
    },
    response: null,
  };
}

function harness(result: BridgeWireCaptureResult) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const writeClipboardText = vi.fn();
  registerBridgeWireCaptureIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
  }, {
    captures: { get: vi.fn(() => result) },
    writeClipboardText,
  });
  return { handlers, writeClipboardText };
}

describe("Bridge wire-capture renderer IPC", () => {
  it("returns the typed production capture result", () => {
    const available = { capture: capture(), state: "available" } as const;
    const { handlers } = harness(available);

    expect(handlers.get(BRIDGE_GET_WIRE_CAPTURE_CHANNEL)?.({}, "req-1")).toEqual(available);
    expect(handlers.get(BRIDGE_GET_WIRE_CAPTURE_CHANNEL)?.({}, "")).toEqual({ state: "not_captured" });
  });

  it("copies the authoritative retained Base64 through Electron", () => {
    const { handlers, writeClipboardText } = harness({ capture: capture(true), state: "available" });

    expect(handlers.get(BRIDGE_COPY_WIRE_PAYLOAD_CHANNEL)?.({}, "req-1")).toEqual({
      capturedBytes: 4,
      status: "copied",
      truncated: true,
    });
    expect(writeClipboardText).toHaveBeenCalledWith("AQIDBA==");
  });

  it("does not write the clipboard for expired or empty request ids", () => {
    const { handlers, writeClipboardText } = harness({ state: "evicted" });

    expect(handlers.get(BRIDGE_COPY_WIRE_PAYLOAD_CHANNEL)?.({}, "req-1")).toEqual({ status: "evicted" });
    expect(handlers.get(BRIDGE_COPY_WIRE_PAYLOAD_CHANNEL)?.({}, "")).toEqual({ status: "invalid_request_id" });
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("accepts every non-empty request id allowed by the Bridge frame protocol", () => {
    const available = { capture: capture(), state: "available" } as const;
    const { handlers, writeClipboardText } = harness(available);
    const longRequestId = "x".repeat(257);

    expect(handlers.get(BRIDGE_GET_WIRE_CAPTURE_CHANNEL)?.({}, longRequestId)).toEqual(available);
    expect(handlers.get(BRIDGE_COPY_WIRE_PAYLOAD_CHANNEL)?.({}, longRequestId)).toMatchObject({ status: "copied" });
    expect(writeClipboardText).toHaveBeenCalledWith("AQIDBA==");
  });
});
