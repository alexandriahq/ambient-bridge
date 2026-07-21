/**
 * Wire-capture values exposed by the Electron main process to the sandboxed
 * Bridge renderer. Keep this module type-only so both the NodeNext preload
 * build and the Vite renderer can consume the same contract.
 */
export type BridgeWireHeader = { name: string; value: string };

export type BridgeWireBody = {
  /** Captured ciphertext bytes encoded as Base64. */
  base64: string;
  /** Number of bytes retained in memory and represented by `base64`. */
  capturedBytes: number;
  /** Total body size when it can be determined, otherwise null. */
  byteLength: number | null;
  /** True when `base64` contains only a prefix of the on-wire body. */
  truncated: boolean;
};

export type BridgeWireCapture = {
  requestId: string;
  at: number;
  request: {
    method: string;
    url: string;
    headers: BridgeWireHeader[];
    body: BridgeWireBody;
  };
  response: {
    status: number;
    headers: BridgeWireHeader[];
    body: BridgeWireBody;
  } | null;
};

export type BridgeWireCaptureResult =
  | { state: "available"; capture: BridgeWireCapture }
  | { state: "evicted" | "not_captured" | "pending" };

export type BridgeCopyWirePayloadResult =
  | {
      status: "copied";
      capturedBytes: number;
      truncated: boolean;
    }
  | { status: "evicted" | "invalid_request_id" | "not_captured" | "pending" };
