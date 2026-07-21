import type { BridgeCopyWirePayloadResult, BridgeWireCaptureResult } from "./bridge-ui-contract.js";

export const BRIDGE_GET_WIRE_CAPTURE_CHANNEL = "bridge:get-wire-capture";
export const BRIDGE_COPY_WIRE_PAYLOAD_CHANNEL = "bridge:copy-wire-payload";

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

export type BridgeUiIpcRegistrar = {
  handle(channel: string, listener: InvokeHandler): void;
};

export type BridgeWireCaptureSource = {
  get(requestId: string): BridgeWireCaptureResult;
};

export function registerBridgeWireCaptureIpc(
  ipc: BridgeUiIpcRegistrar,
  options: {
    readonly captures: BridgeWireCaptureSource;
    readonly writeClipboardText: (value: string) => void;
  },
): void {
  ipc.handle(BRIDGE_GET_WIRE_CAPTURE_CHANNEL, (_event, requestId: unknown): BridgeWireCaptureResult => {
    return validRequestId(requestId) ? options.captures.get(requestId) : { state: "not_captured" };
  });

  ipc.handle(BRIDGE_COPY_WIRE_PAYLOAD_CHANNEL, (_event, requestId: unknown): BridgeCopyWirePayloadResult => {
    if (!validRequestId(requestId)) return { status: "invalid_request_id" };
    const result = options.captures.get(requestId);
    if (result.state !== "available") return { status: result.state };
    options.writeClipboardText(result.capture.request.body.base64);
    return {
      capturedBytes: result.capture.request.body.capturedBytes,
      status: "copied",
      truncated: result.capture.request.body.truncated,
    };
  });
}

function validRequestId(value: unknown): value is string {
  // Match the authenticated Bridge frame protocol: any non-empty string is a
  // valid request id. The enclosing IPC frame already supplies the size bound.
  return typeof value === "string" && value.length > 0;
}
