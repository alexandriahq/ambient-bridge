import { Context, Data, Effect, Schedule } from "effect";
import { SecureClient } from "tinfoil";
import type { AuditSink } from "../diagnostics/audit.js";
import type { JsonValue } from "../ipc-server/protocol.js";
import type { SignedInWorkOsSession, WorkOsSession } from "../workos/session.js";
import { errorMessage } from "../error-message.js";

export type InferenceProxyPath = "/v1/chat/completions" | "/v1/responses" | "/v1/audio/transcriptions";

/**
 * Time budget for the *response* phase of a secure inference fetch — i.e. how long
 * we wait for the enclave to send back HTTP headers. This deliberately does NOT
 * bound the streaming body: once the response resolves, token streaming may take as
 * long as the model needs. Without this cap a stalled enclave fetch (seen under
 * server-side 429 rate limiting) hangs forever and the request stays "In Flight".
 */
export const DEFAULT_INFERENCE_RESPONSE_TIMEOUT_MS = 120_000;

export class BridgeSignedOutError extends Data.TaggedError("BridgeSignedOutError")<{
  readonly message: string;
}> {}

export class BridgeInferenceRequestError extends Data.TaggedError("BridgeInferenceRequestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type BridgeInferenceError = BridgeSignedOutError | BridgeInferenceRequestError;

export interface BridgeSessionServiceShape {
  readonly read: () => Effect.Effect<WorkOsSession, BridgeInferenceRequestError>;
  readonly validate: (session: SignedInWorkOsSession) => Effect.Effect<WorkOsSession, BridgeInferenceRequestError>;
}

export class BridgeSessionService extends Context.Tag("bridge/BridgeSessionService")<
  BridgeSessionService,
  BridgeSessionServiceShape
>() {}

export interface BridgeAuditServiceShape {
  readonly record: (name: string, fields?: Parameters<AuditSink["record"]>[1]) => Effect.Effect<void>;
}

export class BridgeAuditService extends Context.Tag("bridge/BridgeAuditService")<
  BridgeAuditService,
  BridgeAuditServiceShape
>() {}

export interface BridgeSecureClientShape {
  readonly ready: () => Effect.Effect<void, BridgeInferenceRequestError>;
  readonly fetch: (
    path: InferenceProxyPath,
    init: RequestInit,
  ) => Effect.Effect<Response, BridgeInferenceRequestError>;
}

export class BridgeSecureClient extends Context.Tag("bridge/BridgeSecureClient")<
  BridgeSecureClient,
  BridgeSecureClientShape
>() {}

export type SecureClientLike = {
  ready(): Promise<void>;
  readonly fetch: typeof fetch;
};

export type BridgeSecureClientOptions = {
  readonly attestationBundleURL?: string;
  readonly baseURL?: string;
};

export type SecureClientFactory = (options: BridgeSecureClientOptions) => SecureClientLike;

/**
 * Secure inference client. Always uses the fully attestation-verifying Tinfoil
 * `SecureClient`: every request seals its body to the attested enclave key, and the
 * ambient-server relays both the attestation bundle (from `attestationBundleURL`)
 * and the sealed request. There is no unattested path — a self-hosted enclave must
 * produce a real attestation the server passes through, so nothing changes here.
 */
// The Tinfoil SDK rejects responses that lack EHBP envelope headers. That
// happens when an edge/proxy hop answers for the enclave (load-balancer 5xx,
// gateway timeout, connection reset) with a plain unencrypted error response —
// a transient condition, so the fetch is retried before failing the request.
// The request body has not produced a consumable Response yet at that point,
// so re-sending it is safe.
const TRANSIENT_SECURE_FETCH_PATTERNS = [
  /missing ehbp-response-nonce header/i,
  /missing ehbp-encapsulated-key header/i,
];

const SECURE_FETCH_RETRY_SCHEDULE = Schedule.exponential("250 millis").pipe(
  Schedule.jittered,
  Schedule.compose(Schedule.recurs(2)),
);

export function isTransientSecureFetchError(error: unknown): boolean {
  if (!(error instanceof BridgeInferenceRequestError)) return false;
  return TRANSIENT_SECURE_FETCH_PATTERNS.some((pattern) => pattern.test(error.message));
}

export function createBridgeSecureClient(input: {
  readonly serverBaseUrl: string;
  readonly makeSecureClient?: SecureClientFactory;
}): BridgeSecureClientShape {
  const makeSecureClient = input.makeSecureClient ?? ((options) => new SecureClient(options));
  const client = makeSecureClient({
    attestationBundleURL: input.serverBaseUrl,
    baseURL: input.serverBaseUrl,
  });

  return {
    ready: () =>
      Effect.tryPromise({
        try: () => client.ready(),
        catch: (cause) => new BridgeInferenceRequestError({
          message: `Secure client verification failed: ${errorMessage(cause)}`,
          cause,
        }),
      }),
    fetch: (path, init) =>
      Effect.tryPromise({
        try: () => client.fetch(path, init),
        catch: (cause) => new BridgeInferenceRequestError({
          message: `Secure request failed: ${errorMessage(cause)}`,
          cause,
        }),
      }).pipe(
        Effect.retry({
          while: (error) => isTransientSecureFetchError(error) && init.signal?.aborted !== true,
          schedule: SECURE_FETCH_RETRY_SCHEDULE,
        }),
      ),
  };
}

export function createBridgeSessionService(input: {
  readonly read: () => Promise<WorkOsSession>;
  readonly validate?: (session: SignedInWorkOsSession) => Promise<WorkOsSession>;
}): BridgeSessionServiceShape {
  return {
    read: () =>
      Effect.tryPromise({
        try: input.read,
        catch: (cause) => new BridgeInferenceRequestError({
          message: `Could not read Bridge WorkOS session: ${errorMessage(cause)}`,
          cause,
        }),
      }),
    validate: (session) =>
      input.validate
        ? Effect.tryPromise({
          try: () => input.validate!(session),
          catch: (cause) => new BridgeInferenceRequestError({
            message: `Could not validate Bridge WorkOS session: ${errorMessage(cause)}`,
            cause,
          }),
        })
        : Effect.succeed(session),
  };
}

export function createBridgeAuditService(audit: AuditSink): BridgeAuditServiceShape {
  return {
    record: (name, fields) => Effect.sync(() => audit.record(name, fields)),
  };
}

export function secureInferenceResponse(input: {
  readonly appVersion: string;
  readonly feature: string;
  readonly path: InferenceProxyPath;
  readonly payload: JsonValue | undefined;
  readonly body?: BodyInit;
  readonly contentType?: string | null;
  readonly accept?: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly responseTimeoutMs?: number;
}): Effect.Effect<
  Response,
  BridgeInferenceError,
  BridgeSessionService | BridgeSecureClient | BridgeAuditService
> {
  return Effect.gen(function* () {
    const sessionService = yield* BridgeSessionService;
    const secureClient = yield* BridgeSecureClient;
    const audit = yield* BridgeAuditService;

    let session = yield* sessionService.read();
    if (session.kind !== "signed_in") {
      return yield* Effect.fail(new BridgeSignedOutError({ message: "Bridge is not signed in." }));
    }
    session = yield* sessionService.validate(session);
    if (session.kind !== "signed_in") {
      return yield* Effect.fail(new BridgeSignedOutError({ message: "Bridge is not signed in." }));
    }

    const modelId = modelIdFromPayload(input.payload);

    yield* audit.record("inference.secure_client_ready_start", {
      feature: input.feature,
      path: input.path,
      requestId: input.requestId,
    });
    yield* secureClient.ready();

    const headers = new Headers({
      Accept: input.accept ?? "text/event-stream",
      Authorization: `Bearer ${session.sessionToken}`,
      "X-Ambient-App-Version": input.appVersion,
      "X-Ambient-Feature": input.feature,
      "X-Ambient-Request-Id": input.requestId,
    });
    if (modelId) headers.set("X-Ambient-Model-Id", modelId);
    if (input.contentType !== null) {
      headers.set("Content-Type", input.contentType ?? "application/json");
    }

    yield* audit.record("inference.secure_fetch_start", {
      accept: headers.get("Accept"),
      contentType: headers.get("Content-Type"),
      feature: input.feature,
      path: input.path,
      requestId: input.requestId,
      requestBytes: bodyInitSize(input.body),
    });

    const timeoutMs = input.responseTimeoutMs && input.responseTimeoutMs > 0
      ? input.responseTimeoutMs
      : DEFAULT_INFERENCE_RESPONSE_TIMEOUT_MS;

    // Abort the fetch if the enclave never sends response headers within the budget.
    // The timer is cleared as soon as the response resolves, so it can never abort an
    // in-progress token stream; user cancellation still flows through `input.signal`.
    const response = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const timeoutController = new AbortController();
        const timer = setTimeout(() => {
          timeoutController.abort(
            new DOMException(`Inference response timed out after ${timeoutMs}ms`, "TimeoutError"),
          );
        }, timeoutMs);
        timer.unref?.();
        return { timeoutController, timer };
      }),
      ({ timeoutController }) => secureClient.fetch(input.path, {
        body: input.body ?? JSON.stringify(input.payload ?? {}),
        headers,
        method: "POST",
        signal: AbortSignal.any([input.signal, timeoutController.signal]),
      }),
      ({ timer }) => Effect.sync(() => clearTimeout(timer)),
    );

    yield* audit.record("inference.secure_fetch_response", {
      feature: input.feature,
      path: input.path,
      requestId: input.requestId,
      status: response.status,
    });

    return response;
  });
}

function modelIdFromPayload(value: JsonValue | undefined): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const model = value.model;
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  return trimmed && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}


function bodyInitSize(value: BodyInit | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return null;
}
