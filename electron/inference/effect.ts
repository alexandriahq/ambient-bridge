import type { InferenceProxyPath } from "../bridge-ui-contract.js";
export type { InferenceProxyPath } from "../bridge-ui-contract.js";

import { Context, Data, Effect, Schedule } from "effect";
import { SecureClient } from "tinfoil";
import type { AuditSink } from "../diagnostics/audit.js";
import type { JsonValue } from "../ipc-server/protocol.js";
import type { SignedInWorkOsSession, WorkOsSession } from "../workos/session.js";
import { errorMessage } from "../error-message.js";
import {
  BridgeInferenceServiceError,
  BridgeInsufficientCreditError,
  BridgeGloballyDisabledError,
  BridgeUsageRequestError,
  inferenceDomainError,
  inferenceResponseDomainError,
} from "./errors.js";
import { sessionUsageOwnerKey, type InferenceAvailabilityCircuit } from "./availability.js";
import {
  BridgeUsageAccountingDisabledError,
  type BridgeUsageService,
} from "./usage-service.js";
import {
  ALEXANDRIA_FEATURE_HEADER,
  ALEXANDRIA_MODEL_HEADER,
  ALEXANDRIA_MODE_HEADER,
  ALEXANDRIA_REQUEST_ID_HEADER,
} from "@alexandria/inference-contract";

/**
 * Time budget for the *response* phase of a secure inference fetch — i.e. how long
 * we wait for the enclave to send back HTTP headers. This deliberately does NOT
 * bound the streaming body: once the response resolves, token streaming may take as
 * long as the model needs. Without this cap a stalled enclave fetch (seen under
 * server-side 429 rate limiting) hangs forever and the request stays "In Flight".
 */
export const DEFAULT_INFERENCE_RESPONSE_TIMEOUT_MS = 120_000;
// Non-streaming Responses now finalize their body and usage receipt before headers.
// Allow Alexandria Node's default 170-second execution budget to finish first.
export const NON_STREAMING_RESPONSES_TIMEOUT_MS = 180_000;

export class BridgeSignedOutError extends Data.TaggedError("BridgeSignedOutError")<{
  readonly message: string;
}> {}

export class BridgeInferenceRequestError extends Data.TaggedError("BridgeInferenceRequestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type BridgeInferenceError =
  | BridgeSignedOutError
  | BridgeInferenceRequestError
  | BridgeInsufficientCreditError
  | BridgeInferenceServiceError
  | BridgeGloballyDisabledError
  | BridgeUsageRequestError;

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
  ) => Effect.Effect<Response, BridgeInferenceRequestError | BridgeInsufficientCreditError | BridgeInferenceServiceError>;
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

export function createCloudNodeSecureClient(input: {
  readonly client: BridgeSecureClientShape;
  readonly accessToken: string;
  readonly mode: "confidential" | "plaintext";
  readonly feature?: "bridge" | "daily_report";
}): BridgeSecureClientShape {
  return {
    ready: input.client.ready,
    fetch: (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${input.accessToken}`);
      headers.set(ALEXANDRIA_FEATURE_HEADER, input.feature ?? "bridge");
      headers.set(ALEXANDRIA_MODE_HEADER, input.mode);
      const requestId = headers.get("X-Ambient-Request-Id");
      const model = headers.get("X-Ambient-Model-Id");
      if (requestId) headers.set(ALEXANDRIA_REQUEST_ID_HEADER, requestId);
      if (model) headers.set(ALEXANDRIA_MODEL_HEADER, model);
      return input.client.fetch(path, { ...init, headers });
    },
  };
}

/**
 * Secure inference client. The default path uses the fully attestation-verifying
 * Tinfoil `SecureClient`: every request seals its body to the attested enclave
 * key, and the ambient-server relays both the attestation bundle (from
 * `attestationBundleURL`) and the sealed request. A self-hosted enclave must
 * produce a real attestation the server passes through.
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
        catch: (cause) => inferenceDomainError(cause) ?? new BridgeInferenceRequestError({
          message: `Secure request failed: ${errorMessage(cause)}`,
          cause,
        }),
      }).pipe(
        Effect.retry({
          while: (error) => isTransientSecureFetchError(error)
            && !new Headers(init.headers).has("x-ambient-credit-reservation")
            && init.signal?.aborted !== true,
          schedule: SECURE_FETCH_RETRY_SCHEDULE,
        }),
      ),
  };
}

/**
 * Plaintext transport for a Cloud-assigned Node. Uses ordinary HTTPS without EHBP.
 */
export function createBridgePlaintextClient(input: {
  readonly serverBaseUrl: string;
  readonly fetchImpl?: typeof fetch;
}): BridgeSecureClientShape {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.serverBaseUrl.replace(/\/+$/, "");
  return {
    ready: () => Effect.void,
    fetch: (path, init) =>
      Effect.tryPromise({
        try: () => {
          const headers = new Headers(init.headers);
          return fetchImpl(`${base}${path}`, { ...init, headers });
        },
        catch: (cause) => inferenceDomainError(cause) ?? new BridgeInferenceRequestError({
          message: `Node plaintext request failed: ${errorMessage(cause)}`,
          cause,
        }),
      }),
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
  readonly traceparent?: string;
  readonly usage?: BridgeUsageService;
  readonly availability?: InferenceAvailabilityCircuit;
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
    const ownerKey = sessionUsageOwnerKey(session);
    if (input.availability) {
      try {
        input.availability.beforeRequest(ownerKey);
      } catch (error) {
        const domainError = inferenceDomainError(error);
        if (domainError) return yield* Effect.fail(domainError);
        throw error;
      }
    }

    let reservationId: string | null = null;
    if (input.usage) {
      if (!modelId) {
        input.availability?.serviceProbeFailed();
        return yield* Effect.fail(new BridgeUsageRequestError("Inference model identity is required for usage accounting."));
      }
      const reserved = yield* input.usage.reserve({
        session,
        requestId: input.requestId,
        route: input.path,
        modelId,
      }).pipe(
        Effect.catchAll((error) => error instanceof BridgeUsageAccountingDisabledError
          ? Effect.succeed(null)
          : Effect.fail(error)),
        Effect.tapError((error) => Effect.sync(() => {
          if (error instanceof BridgeInsufficientCreditError) {
            input.availability?.accountExhausted(ownerKey, error);
            input.availability?.serviceProbeFailed();
          } else if (error instanceof BridgeInferenceServiceError) {
            input.availability?.serviceUnavailable(error);
          } else {
            input.availability?.serviceProbeFailed();
          }
        })),
      );
      reservationId = reserved?.reservationId ?? null;
    }

    yield* audit.record("inference.secure_client_ready_start", {
      feature: input.feature,
      path: input.path,
      requestId: input.requestId,
    });
    yield* secureClient.ready().pipe(
      Effect.tapError(() => {
        input.availability?.serviceProbeFailed();
        return input.usage && reservationId
          ? input.usage.release(session, reservationId).pipe(Effect.catchAll(() => Effect.void))
          : Effect.void;
      }),
    );

    const headers = new Headers({
      Accept: input.accept ?? "text/event-stream",
      Authorization: `Bearer ${session.sessionToken}`,
      "X-Ambient-App-Version": input.appVersion,
      "X-Ambient-Feature": input.feature,
      "X-Ambient-Request-Id": input.requestId,
    });
    if (input.traceparent) headers.set("traceparent", input.traceparent);
    if (modelId) headers.set("X-Ambient-Model-Id", modelId);
    if (reservationId) headers.set("X-Ambient-Credit-Reservation", reservationId);
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

    const nonStreamingResponses = input.path === "/v1/responses"
      && input.payload !== null && typeof input.payload === "object"
      && !Array.isArray(input.payload) && input.payload.stream !== true;
    const timeoutMs = input.responseTimeoutMs && input.responseTimeoutMs > 0
      ? input.responseTimeoutMs
      : nonStreamingResponses ? NON_STREAMING_RESPONSES_TIMEOUT_MS : DEFAULT_INFERENCE_RESPONSE_TIMEOUT_MS;

    // Abort the fetch if the enclave never sends response headers within the budget.
    // The timer is cleared as soon as the response resolves, so it can never abort an
    // in-progress token stream; user cancellation still flows through `input.signal`.
    const secureFetch = Effect.acquireUseRelease(
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
    const response = yield* secureFetch.pipe(
      Effect.flatMap((response) => {
        const error = inferenceResponseDomainError(response);
        if (!error) return Effect.succeed(response);
        // Error bodies may contain provider details. Never parse or log them.
        return Effect.promise(async () => { try { await response.body?.cancel(); } catch { /* best effort */ } })
          .pipe(Effect.zipRight(Effect.fail(error)));
      }),
      Effect.tapError((error) => Effect.gen(function* () {
        const domainError = inferenceDomainError(error);
        if (domainError instanceof BridgeInferenceServiceError) {
          input.availability?.serviceUnavailable(domainError);
        } else if (domainError instanceof BridgeInsufficientCreditError) {
          input.availability?.accountExhausted(ownerKey, domainError);
          input.availability?.serviceProbeFailed();
        } else {
          input.availability?.serviceProbeFailed();
        }
        if (input.usage && reservationId) {
          yield* input.usage.release(session, reservationId).pipe(Effect.catchAll(() => Effect.void));
        }
      })),
    );
    if (response.ok) input.availability?.serviceRecovered();
    else input.availability?.serviceProbeFailed();

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
