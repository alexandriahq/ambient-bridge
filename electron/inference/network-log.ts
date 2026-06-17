import type { InferenceProxyPath } from "./effect.js";

export type InferenceUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type NetworkRequestAttestation = "pending" | "verified" | "failed";

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
  status: NetworkRequestStatus;
  statusCode: number | null;
  requestBytes: number | null;
  encryption: "ehbp";
  attestation: NetworkRequestAttestation;
  ehbpResponseNonce: string | null;
  tinfoilRequestId: string | null;
  usage: InferenceUsage | null;
  error: string | null;
  /** True once raw on-the-wire ciphertext has been captured for this request. */
  wireCaptured: boolean;
};

export type HeadersLike = {
  get(name: string): string | null;
};

export type EhbpResponseEvidence = {
  ehbpResponseNonce: string | null;
  tinfoilRequestId: string | null;
  usage: InferenceUsage | null;
};

const EHBP_RESPONSE_NONCE_HEADER = "ehbp-response-nonce";
const TINFOIL_REQUEST_ID_HEADER = "x-tinfoil-request-id";
const TINFOIL_USAGE_METRICS_HEADER = "x-tinfoil-usage-metrics";

/**
 * Parse the Tinfoil usage header (`prompt=67,completion=42,total=109`). Mirrors
 * the server-side parser so the Bridge UI can surface token usage without ever
 * touching request/response bodies. Returns null on any malformed input.
 */
export function parseInferenceUsageMetrics(value: string | null | undefined): InferenceUsage | null {
  if (!value) return null;
  const fields = new Map<string, number>();
  for (const part of value.split(",")) {
    const match = /^\s*([A-Za-z_]+)=(\d+)\s*$/.exec(part);
    if (!match) return null;
    const parsed = Number(match[2]);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
    fields.set(match[1]!.toLowerCase(), parsed);
  }

  const promptTokens = fields.get("prompt");
  const completionTokens = fields.get("completion");
  const totalTokens = fields.get("total");
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
    return null;
  }
  return { completionTokens, promptTokens, totalTokens };
}

/**
 * Read the EHBP / Tinfoil envelope evidence from a secure response's headers.
 * All fields are best-effort: when a header is absent (e.g. usage arrives as a
 * streaming trailer) we simply omit it and keep the rest of the record.
 */
export function readEhbpResponseEvidence(headers: HeadersLike): EhbpResponseEvidence {
  return {
    ehbpResponseNonce: nonEmpty(headers.get(EHBP_RESPONSE_NONCE_HEADER)),
    tinfoilRequestId: nonEmpty(headers.get(TINFOIL_REQUEST_ID_HEADER)),
    usage: parseInferenceUsageMetrics(headers.get(TINFOIL_USAGE_METRICS_HEADER)),
  };
}

function nonEmpty(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type StartNetworkRequestInput = {
  requestId: string;
  feature: string;
  model: string | null;
  path: InferenceProxyPath;
  startedAt: number;
  requestBytes?: number | null;
};

/**
 * In-memory ring buffer of recent inference egress requests, most-recent-first.
 * Records are mutated in place as a request progresses (attestation -> response
 * -> completion) and snapshotted on read so the renderer never shares state.
 */
export class NetworkRequestHistory {
  private readonly records: NetworkRequestRecord[] = [];

  constructor(private readonly limit = 100) {}

  start(input: StartNetworkRequestInput): NetworkRequestRecord {
    const record: NetworkRequestRecord = {
      attestation: "pending",
      completedAt: null,
      ehbpResponseNonce: null,
      encryption: "ehbp",
      error: null,
      feature: input.feature,
      model: input.model,
      path: input.path,
      requestBytes: input.requestBytes ?? null,
      requestId: input.requestId,
      startedAt: input.startedAt,
      status: "active",
      statusCode: null,
      tinfoilRequestId: null,
      usage: null,
      wireCaptured: false,
    };

    const existingIndex = this.records.findIndex((entry) => entry.requestId === record.requestId);
    if (existingIndex !== -1) {
      this.records.splice(existingIndex, 1);
    }
    this.records.unshift(record);
    if (this.records.length > this.limit) {
      this.records.length = this.limit;
    }
    return record;
  }

  patch(requestId: string, patch: Partial<NetworkRequestRecord>): NetworkRequestRecord | null {
    const record = this.records.find((entry) => entry.requestId === requestId);
    if (!record) return null;
    Object.assign(record, patch);
    return record;
  }

  list(): NetworkRequestRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  latest(): NetworkRequestRecord | null {
    const record = this.records[0];
    return record ? { ...record } : null;
  }
}
