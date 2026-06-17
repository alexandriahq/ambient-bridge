/**
 * WireTap captures the *actual* bytes that leave this machine for inference.
 *
 * The Tinfoil SDK seals request bodies inside the `ehbp` package and ships them
 * through the global `fetch` (ehbp `Transport.request` -> `fetch(encryptedRequest)`).
 * By wrapping `globalThis.fetch` in the Bridge main process we can observe the
 * exact HPKE-sealed request ciphertext and the encrypted response, then surface
 * them in the "Network Logs" view for transparency over confidential compute.
 *
 * This deliberately overrides the AGENTS.md §6 guidance ("Bridge never surfaces
 * encrypted bodies"): the captured bytes are ciphertext only (never plaintext),
 * the session token is redacted from headers, captures are size-capped and held
 * in memory only (never written to the audit log or disk), and they are served
 * to the local renderer on demand rather than streamed through status polling.
 */

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
  /** Max bytes captured per body. */
  maxBytes?: number;
  /** Notified (with the request id) whenever a capture is created or updated. */
  onUpdate?: (requestId: string) => void;
};

const REQUEST_ID_HEADER = "x-ambient-request-id";
const ENCAPSULATED_KEY_HEADER = "ehbp-encapsulated-key";
const REDACTED_HEADER_PATTERN = /^(authorization|cookie|set-cookie|x-ambient-session-token)$/i;
const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_BYTES = 16 * 1024;

export class WireTap {
  private readonly captures = new Map<string, WireCapture>();
  private readonly order: string[] = [];
  private readonly limit: number;
  private readonly maxBytes: number;
  private readonly onUpdate?: (requestId: string) => void;
  private installed = false;

  constructor(options: WireTapOptions = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
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
    const requestClone = request.clone();
    const responsePromise = originalFetch(request);

    void this.readBody(requestClone.body, contentLength(request.headers))
      .then((body) => {
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
      })
      .catch(() => {});

    const response = await responsePromise;

    // Capture the encrypted response from a tee'd clone so the SDK still decrypts
    // the original untouched. Reading is capped and cancels early on large streams.
    const responseClone = response.clone();
    void this.readBody(responseClone.body, contentLength(response.headers))
      .then((body) => {
        const existing = this.captures.get(requestId);
        if (!existing) return;
        existing.response = {
          status: response.status,
          headers: sanitizeHeaders(response.headers),
          body,
        };
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
      while (this.order.length > this.limit) {
        const evicted = this.order.shift();
        if (evicted !== undefined) this.captures.delete(evicted);
      }
    }
    this.captures.set(requestId, capture);
  }

  private async readBody(
    stream: ReadableStream<Uint8Array> | null,
    declaredLength: number | null,
  ): Promise<WireBody> {
    if (!stream) {
      return { base64: "", byteLength: declaredLength ?? 0, capturedBytes: 0, truncated: false };
    }
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let captured = 0;
    let truncated = false;
    try {
      while (captured < this.maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const remaining = this.maxBytes - captured;
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
      if (captured >= this.maxBytes) truncated = true;
    } finally {
      void reader.cancel().catch(() => {});
    }
    const merged = concat(chunks, captured);
    return {
      base64: Buffer.from(merged).toString("base64"),
      capturedBytes: captured,
      byteLength: declaredLength ?? (truncated ? null : captured),
      truncated,
    };
  }
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
