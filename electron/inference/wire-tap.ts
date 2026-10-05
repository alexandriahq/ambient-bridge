/**
 * WireTap captures the *actual* bytes that leave this machine for inference.
 *
 * The Tinfoil SDK seals request bodies inside the `ehbp` package and ships them
 * through the global `fetch` (ehbp `Transport.request` -> `fetch(encryptedRequest)`).
 * By wrapping `globalThis.fetch` in the Bridge main process we can observe the
 * exact HPKE-sealed request ciphertext and the encrypted response, then surface
 * them in the "Network Logs" view for transparency over confidential compute.
 *
 * This is the bounded exception to the default logging guidance
 * (docs/agents/observability.md, "never surface inference bodies") that
 * docs/agents/security-model.md calls out for Bridge: the captured bytes are
 * ciphertext only (never plaintext),
 * the session token is redacted from headers, captures are size-capped and held
 * in memory only (never written to the audit log or disk), and they are served
 * to the local renderer on demand rather than streamed through status polling.
 */

import {
  BridgeInferenceServiceError,
  BridgeInsufficientCreditError,
  boundedRetryAfterSeconds,
} from "./errors.js";

export type WireHeader = { name: string; value: string };

export type WireBody = {
  /** Captured bytes, base64-encoded (ciphertext). */
  base64: string;
  /** Number of bytes actually captured (<= maxBytes). */
  capturedBytes: number;
  /** Total body size if known (Content-Length), else null when truncated/unknown. */
  byteLength: number | null;
  /** True when the body was larger than the capture cap. */
  truncated: boolean;
};

export type WireRequestCapture = {
  method: string;
  url: string;
  headers: WireHeader[];
  body: WireBody;
};

export type WireResponseCapture = {
  status: number;
  headers: WireHeader[];
  body: WireBody;
};

export type WireCapture = {
  requestId: string;
  at: number;
  request: WireRequestCapture;
  response: WireResponseCapture | null;
};

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type FetchHost = { fetch: FetchLike };

export type WireTapOptions = {
  /** Max distinct request captures retained (ring buffer). */
  limit?: number;
  /** Legacy override that applies the same cap to request and response bodies. */
  maxBytes?: number;
  /** Max bytes captured from a sealed request body. */
  maxRequestBytes?: number;
  /** Max bytes captured from an encrypted response body. */
  maxResponseBytes?: number;
  /** Max raw ciphertext bytes retained across all captures. */
  maxTotalBytes?: number;
  /** Notified (with the request id) whenever a capture is created or updated. */
  onUpdate?: (requestId: string) => void;
  /** Notified when a retained capture is removed by a count or byte bound. */
  onEvict?: (requestId: string) => void;
};

const REQUEST_ID_HEADER = "x-ambient-request-id";
const ENCAPSULATED_KEY_HEADER = "ehbp-encapsulated-key";
const REDACTED_HEADER_PATTERN = /^(authorization|cookie|set-cookie|x-ambient-session-token)$/i;
const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export class WireTap {
  private readonly captures = new Map<string, WireCapture>();
  private readonly order: string[] = [];
  private readonly limit: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly maxTotalBytes: number;
  private readonly onEvict?: (requestId: string) => void;
  private readonly onUpdate?: (requestId: string) => void;
  private installed = false;
  private generation = 0;
  private readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();

  constructor(options: WireTapOptions = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.maxRequestBytes = options.maxRequestBytes ?? options.maxBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.maxResponseBytes = options.maxResponseBytes ?? options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.onEvict = options.onEvict;
    this.onUpdate = options.onUpdate;
  }

  /** Wrap a fetch host (defaults to globalThis) so sealed inference traffic is captured. */
  install(host: FetchHost = globalThis as unknown as FetchHost): void {
    if (this.installed) return;
    this.installed = true;
    const originalFetch = host.fetch.bind(host) as FetchLike;
    host.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      this.intercept(originalFetch, input, init)) as typeof fetch;
  }

  get(requestId: string): WireCapture | null {
    const capture = this.captures.get(requestId);
    if (!capture) return null;
    return structuredClone(capture);
  }

  clear(): void {
    this.generation += 1;
    this.captures.clear();
    this.order.length = 0;
    const readers = this.readers;
    this.readers = new Set();
    // A tee cancellation may wait for the real request/response consumer.
    // Retire only our branches, without blocking that consumer or clear().
    for (const reader of readers) void reader.cancel().catch(() => {});
  }

  private async intercept(
    originalFetch: FetchLike,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const request = this.toRequest(input, init);
    const requestId = request?.headers.get(REQUEST_ID_HEADER) ?? null;
    const sealed = request?.headers.has(ENCAPSULATED_KEY_HEADER) ?? false;
    if (!request || !requestId || !sealed) {
      return originalFetch(input, init);
    }

    // Read the sealed request bytes from a clone, in parallel with the real send.
    const captureGeneration = this.generation;
    const requestClone = request.clone();
    const responsePromise = originalFetch(request);

    const requestStored = this.readBody(requestClone.body, contentLength(request.headers), this.maxRequestBytes, captureGeneration)
      .then((body) => {
        if (captureGeneration !== this.generation) return;
        this.store(requestId, {
          requestId,
          at: Date.now(),
          request: {
            method: request.method,
            url: request.url,
            headers: sanitizeHeaders(request.headers),
            body,
          },
          response: null,
        });
        this.onUpdate?.(requestId);
      });
    void requestStored.catch(() => {});

    const response = await responsePromise;

    const plainError = plainInferenceError(response);
    if (plainError) {
      await requestStored.catch(() => {});
      if (captureGeneration === this.generation) {
        const existing = this.captures.get(requestId);
        if (existing) {
          existing.response = {
            status: response.status,
            headers: sanitizeHeaders(response.headers),
            // A non-EHBP body is unverified provider/edge plaintext. Never retain
            // it in the ciphertext inspector or let it be mislabeled as sealed.
            body: { base64: "", byteLength: null, capturedBytes: 0, truncated: response.body !== null },
          };
          this.prune();
          this.onUpdate?.(requestId);
        }
      }
      try {
        await response.body?.cancel();
      } catch {
        // The unverified body is deliberately discarded.
      }
      throw plainError;
    }

    if (captureGeneration !== this.generation) return response;

    // Capture the encrypted response from a tee'd clone so the SDK still decrypts
    // the original untouched. Reading is capped and cancels early on large streams.
    const responseClone = response.clone();
    void Promise.all([
      requestStored,
      this.readBody(responseClone.body, contentLength(response.headers), this.maxResponseBytes, captureGeneration),
    ])
      .then(([, body]) => {
        if (captureGeneration !== this.generation) return;
        const existing = this.captures.get(requestId);
        if (!existing) return;
        existing.response = {
          status: response.status,
          headers: sanitizeHeaders(response.headers),
          body,
        };
        this.prune();
        this.onUpdate?.(requestId);
      })
      .catch(() => {});

    return response;
  }

  private toRequest(input: RequestInfo | URL, init?: RequestInit): Request | null {
    try {
      if (input instanceof Request) return input;
      return new Request(input, init);
    } catch {
      return null;
    }
  }

  private store(requestId: string, capture: WireCapture): void {
    if (!this.captures.has(requestId)) {
      this.order.push(requestId);
    }
    this.captures.set(requestId, capture);
    this.prune();
  }

  private prune(): void {
    while (this.order.length > this.limit || this.retainedBytes() > this.maxTotalBytes) {
      if (!this.evictOldest()) break;
    }
  }

  private evictOldest(): boolean {
    const requestId = this.order.shift();
    if (requestId === undefined) return false;
    const deleted = this.captures.delete(requestId);
    if (deleted) this.onEvict?.(requestId);
    return true;
  }

  private retainedBytes(): number {
    let total = 0;
    for (const capture of this.captures.values()) {
      total += capture.request.body.capturedBytes;
      total += capture.response?.body.capturedBytes ?? 0;
    }
    return total;
  }

  private async readBody(
    stream: ReadableStream<Uint8Array> | null,
    declaredLength: number | null,
    maxBytes: number,
    captureGeneration: number,
  ): Promise<WireBody> {
    if (captureGeneration !== this.generation) {
      void stream?.cancel().catch(() => {});
      return { base64: "", byteLength: null, capturedBytes: 0, truncated: true };
    }
    if (!stream) {
      return { base64: "", byteLength: declaredLength ?? 0, capturedBytes: 0, truncated: false };
    }
    const reader = stream.getReader();
    this.readers.add(reader);
    const chunks: Uint8Array[] = [];
    let captured = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || captureGeneration !== this.generation) break;
        if (!value || value.byteLength === 0) continue;
        const remaining = maxBytes - captured;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        if (value.byteLength <= remaining) {
          chunks.push(value);
          captured += value.byteLength;
        } else {
          chunks.push(value.subarray(0, remaining));
          captured += remaining;
          truncated = true;
          break;
        }
      }
    } finally {
      this.readers.delete(reader);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (captureGeneration !== this.generation) {
      return { base64: "", byteLength: null, capturedBytes: 0, truncated: true };
    }
    const merged = concat(chunks, captured);
    return {
      base64: Buffer.from(merged.buffer, merged.byteOffset, merged.byteLength).toString("base64"),
      capturedBytes: captured,
      byteLength: declaredLength ?? (truncated ? null : captured),
      truncated,
    };
  }
}

function plainInferenceError(response: Response): BridgeInferenceServiceError | BridgeInsufficientCreditError | null {
  if (response.ok || response.headers.has("ehbp-response-nonce")) return null;
  const code = response.headers.get("x-ambient-error-code");
  const source = response.headers.get("x-ambient-error-source");
  if (code === "INSUFFICIENT_CREDIT" && source === "ambient_account") {
    return new BridgeInsufficientCreditError(undefined, response.status);
  }
  if (code === "UPSTREAM_BILLING_UNAVAILABLE" || (response.status === 402 && code !== "INSUFFICIENT_CREDIT")) {
    return new BridgeInferenceServiceError(
      "UPSTREAM_BILLING_UNAVAILABLE",
      response.status,
      boundedRetryAfterSeconds(response.headers.get("retry-after"), 60),
      source === "openrouter_provider" ? source : "tinfoil_provider",
    );
  }
  if (code === "SERVER_BUSY" && source === "ambient_server") {
    return new BridgeInferenceServiceError(
      "UPSTREAM_ENVELOPE_UNAVAILABLE",
      response.status,
      boundedRetryAfterSeconds(response.headers.get("retry-after"), 2),
    );
  }
  return new BridgeInferenceServiceError(
    "UPSTREAM_ENVELOPE_UNAVAILABLE",
    response.status,
    boundedRetryAfterSeconds(response.headers.get("retry-after"), 30),
  );
}

function contentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function sanitizeHeaders(headers: Headers): WireHeader[] {
  const out: WireHeader[] = [];
  for (const [name, value] of headers) {
    out.push({ name, value: REDACTED_HEADER_PATTERN.test(name) ? "[redacted]" : value });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
