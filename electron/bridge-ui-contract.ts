/**
 * Passive inference request-log and wire-capture contracts shared by the
 * Electron main process and sandboxed Bridge renderer. Keep this module
 * type-only so NodeNext preload and Vite renderer builds share no runtime code.
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

export type InferenceProxyPath = "/v1/chat/completions" | "/v1/responses" | "/v1/audio/transcriptions" | "/v1/embeddings";

export type InferenceUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/**
 * Tracks the attestation check every inference request runs: `pending` while the
 * enclave identity is being verified, then `verified` or `failed`. Demo
 * OpenRouter hops skip attestation and stay `skipped`.
 */
export type NetworkRequestAttestation = "pending" | "verified" | "failed" | "skipped";

export type NetworkRequestEncryption = "ehbp" | "none";

export type NetworkRequestStatus = "active" | "completed" | "failed" | "cancelled";

/**
 * A single inference egress request, captured for the Bridge "Network Logs" view.
 *
 * Everything here is metadata and encryption evidence. Per the Bridge security
 * model we never capture plaintext prompts/completions or encrypted bodies; the
 * EHBP nonce and Tinfoil request id are public envelope artifacts that prove the
 * payload was sealed before it left this device.
 */
export type NetworkRequestRecord = {
  requestId: string;
  feature: string;
  model: string | null;
  path: InferenceProxyPath;
  startedAt: number;
  completedAt: number | null;
  responseHeadersAt: number | null;
  firstChunkAt: number | null;
  status: NetworkRequestStatus;
  statusCode: number | null;
  requestBytes: number | null;
  encryption: NetworkRequestEncryption;
  attestation: NetworkRequestAttestation;
  ehbpResponseNonce: string | null;
  tinfoilRequestId: string | null;
  usage: InferenceUsage | null;
  error: string | null;
  /** True once raw on-the-wire ciphertext has been captured for this request. */
  wireCaptured: boolean;
  /** W3C trace id shared with Ambient App and ambient-server logs. */
  traceId: string | null;
};
