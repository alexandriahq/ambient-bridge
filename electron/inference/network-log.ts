import type {
  InferenceProxyPath,
  InferenceUsage,
  NetworkRequestAttestation,
  NetworkRequestEncryption,
  NetworkRequestRecord,
} from "../bridge-ui-contract.js";

export type {
  InferenceUsage,
  NetworkRequestAttestation,
  NetworkRequestEncryption,
  NetworkRequestStatus,
  NetworkRequestRecord,
} from "../bridge-ui-contract.js";

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

const USAGE_FIELD_ALIASES: ReadonlyMap<string, "prompt" | "completion" | "total"> = new Map([
  ["prompt", "prompt"],
  ["prompt_tokens", "prompt"],
  ["input", "prompt"],
  ["input_tokens", "prompt"],
  ["completion", "completion"],
  ["completion_tokens", "completion"],
  ["output", "completion"],
  ["output_tokens", "completion"],
  ["total", "total"],
  ["total_tokens", "total"],
]);

/**
 * Parse Tinfoil `X-Tinfoil-Usage-Metrics` header/trailer values.
 * Keep this aligned with ambient-server `parseTinfoilUsageMetrics`: live headers
 * include `model=gemma4-31b` and cached-token fields. The old strict
 * `prompt=N,completion=N,total=N` parser dropped every chat row, so Settings →
 * Usage showed 0 tokens / $0.00 while Whisper (per-request) still priced.
 */
export function parseInferenceUsageMetrics(value: string | null | undefined): InferenceUsage | null {
  if (value == null || value.trim() === "") return null;
  const fields = new Map<string, number>();
  for (const part of value.split(/[,;]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const numeric = /^([A-Za-z_]+)\s*=\s*(\d+)$/.exec(trimmed);
    if (numeric) {
      const parsed = Number(numeric[2]);
      if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
      const canonical = USAGE_FIELD_ALIASES.get(numeric[1]!.toLowerCase());
      if (canonical) fields.set(canonical, parsed);
      continue;
    }
    // Non-numeric metadata such as model=gemma4-31b.
    if (/^([A-Za-z_]+)\s*=\s*.+$/.test(trimmed)) continue;
    return null;
  }

  const promptTokens = fields.get("prompt");
  const completionTokens = fields.get("completion");
  const totalTokens = fields.get("total")
    ?? (promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined);
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

/**
 * Streaming chat often puts usage in HTTP trailers. Node/Electron fetch may
 * only expose that after the body is consumed. Re-read headers, then `trailer`.
 */
export async function readEhbpUsageAfterBody(response: Response): Promise<InferenceUsage | null> {
  const fromHeaders = parseInferenceUsageMetrics(response.headers.get(TINFOIL_USAGE_METRICS_HEADER));
  if (fromHeaders) return fromHeaders;
  const trailer = (response as Response & { readonly trailer?: Promise<Headers> }).trailer;
  if (!trailer) return null;
  try {
    const headers = await trailer;
    return parseInferenceUsageMetrics(headers.get(TINFOIL_USAGE_METRICS_HEADER));
  } catch {
    return null;
  }
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
  /** Initial attestation state; defaults to `pending`. */
  attestation?: NetworkRequestAttestation;
  /** Initial encryption; defaults to `ehbp`. */
  encryption?: NetworkRequestEncryption;
  traceId?: string | null;
};

/**
 * In-memory ring buffer of recent inference egress requests, most-recent-first.
 * Records are mutated in place as a request progresses (attestation -> response
 * -> completion) and snapshotted on read so the renderer never shares state.
 */
export class NetworkRequestHistory {
  private readonly records: Array<{ readonly key: string; readonly record: NetworkRequestRecord }> = [];

  constructor(private readonly limit = 100) {}

  start(input: StartNetworkRequestInput, key = input.requestId): NetworkRequestRecord {
    const record: NetworkRequestRecord = {
      attestation: input.attestation ?? "pending",
      completedAt: null,
      firstChunkAt: null,
      ehbpResponseNonce: null,
      encryption: input.encryption ?? "ehbp",
      error: null,
      feature: input.feature,
      model: input.model,
      path: input.path,
      requestBytes: input.requestBytes ?? null,
      requestId: input.requestId,
      responseHeadersAt: null,
      startedAt: input.startedAt,
      status: "active",
      statusCode: null,
      tinfoilRequestId: null,
      usage: null,
      wireCaptured: false,
      traceId: input.traceId ?? null,
    };

    const existingIndex = this.records.findIndex((entry) => entry.key === key);
    if (existingIndex !== -1) {
      this.records.splice(existingIndex, 1);
    }
    this.records.unshift({ key, record });
    if (this.records.length > this.limit) {
      this.records.length = this.limit;
    }
    return record;
  }

  patch(key: string, patch: Partial<NetworkRequestRecord>): NetworkRequestRecord | null {
    const entry = this.records.find((candidate) => candidate.key === key);
    if (!entry) return null;
    Object.assign(entry.record, patch);
    return entry.record;
  }

  /** Best-effort adapter for observers that only see the public wire request id. */
  patchLatestByRequestId(requestId: string, patch: Partial<NetworkRequestRecord>): NetworkRequestRecord | null {
    const entry = this.records.find((candidate) => candidate.record.requestId === requestId);
    if (!entry) return null;
    Object.assign(entry.record, patch);
    return entry.record;
  }

  list(limit?: number): NetworkRequestRecord[] {
    const entries = limit === undefined || !Number.isFinite(limit) || limit < 0
      ? this.records
      : this.records.slice(0, Math.floor(limit));
    return entries.map(({ record }) => ({ ...record }));
  }

  latest(): NetworkRequestRecord | null {
    const entry = this.records[0];
    return entry ? { ...entry.record } : null;
  }

  /** Owner key first, then public wire request id. */
  get(requestId: string): NetworkRequestRecord | null {
    const entry = this.records.find((candidate) => candidate.key === requestId)
      ?? this.records.find((candidate) => candidate.record.requestId === requestId);
    return entry ? { ...entry.record } : null;
  }

  clear(): void {
    this.records.length = 0;
  }
}
