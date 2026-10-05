import { BRIDGE_INFERENCE_MODE_FIELD } from "@ambient/shared/product-version";
import type { JsonValue } from "../ipc-server/protocol.js";
import type { InferenceProxyPath } from "./effect.js";

/**
 * Per-request inference mode (ADR-0313). One Node serves every mode its
 * organization allows and each account picks one, so the app sends the mode
 * with every `inference.*` request as `inferenceMode` in the payload. Bridge
 * advertises the `inference.mode` capability in `bridge.health`; the app sends
 * the field only then, so a released Bridge (1.0.9) never sees it.
 *
 * Absent = the Node's assigned mode (bootstrap `inferenceMode`), exactly what
 * released apps get. A present but unknown value is refused, never guessed:
 * guessing could send a Confidential request as Zero Data Retention.
 */
export type RequestInferenceMode = "confidential" | "zero-retention";

/** Node transport mode: `plaintext` is Zero Data Retention. */
export type NodeInferenceMode = "confidential" | "plaintext";

export class InferenceModeRequestError extends Error {
  readonly code = "invalid_inference_mode";

  constructor(message: string) {
    super(message);
    this.name = "InferenceModeRequestError";
  }
}

/**
 * Reads and removes `inferenceMode` from an inference payload. The rest of the
 * payload is the upstream request body, so the field must never be forwarded.
 */
export function requestInferenceModeFromPayload(payload: JsonValue | undefined): {
  readonly mode: RequestInferenceMode | null;
  readonly payload: JsonValue | undefined;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !(BRIDGE_INFERENCE_MODE_FIELD in payload)) {
    return { mode: null, payload };
  }
  const { [BRIDGE_INFERENCE_MODE_FIELD]: value, ...rest } = payload;
  if (value === null || value === undefined) return { mode: null, payload: rest };
  if (value !== "confidential" && value !== "zero-retention") {
    throw new InferenceModeRequestError("inferenceMode must be confidential or zero-retention.");
  }
  return { mode: value, payload: rest };
}

/** The Node mode one request runs in: the app's choice when it sent one, else the assignment's. */
export function nodeModeForRequest(
  assigned: NodeInferenceMode,
  requested: RequestInferenceMode | null,
): NodeInferenceMode {
  if (requested === null) return assigned;
  return requested === "zero-retention" ? "plaintext" : "confidential";
}

/**
 * Embeddings (retrieval, BGE-M3) run only in Zero Data Retention. A request in
 * Confidential is refused here; it is never sent as plaintext instead.
 */
export function assertInferencePathAllowedInMode(path: InferenceProxyPath, mode: NodeInferenceMode): void {
  if (path === "/v1/embeddings" && mode !== "plaintext") {
    throw new Error("Embeddings run only in Alexandria Zero Data Retention. This request uses Confidential Inference.");
  }
}

/**
 * The client for one request's mode. Confidential always uses the
 * attestation-verifying Tinfoil client through the Node, whatever the Node's
 * default mode; there is no plaintext fallback for a Confidential request.
 */
export function inferenceClientForMode<T>(
  mode: NodeInferenceMode,
  clients: { readonly cloudNodePlaintext: T; readonly cloudNodeConfidential: T },
): T {
  return mode === "plaintext" ? clients.cloudNodePlaintext : clients.cloudNodeConfidential;
}
