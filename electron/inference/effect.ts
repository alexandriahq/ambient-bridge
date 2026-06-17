import { Context, Data, Effect } from "effect";
import { SecureClient, type TransportMode } from "tinfoil";
import type { AuditSink } from "../diagnostics/audit.js";
import type { JsonValue } from "../ipc-server/protocol.js";
import type { SignedInWorkOsSession, WorkOsSession } from "../workos/session.js";
import { errorMessage } from "../error-message.js";

export type InferenceProxyPath = "/v1/chat/completions" | "/v1/responses" | "/v1/audio/transcriptions";

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
  readonly fetch: (path: InferenceProxyPath, init: RequestInit) => Effect.Effect<Response, BridgeInferenceRequestError>;
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
  readonly configRepo?: string;
  readonly enclaveURL?: string;
  readonly transport?: TransportMode;
};

export type SecureClientFactory = (options: BridgeSecureClientOptions) => SecureClientLike;

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
          message: `Tinfoil secure client verification failed: ${errorMessage(cause)}`,
          cause,
        }),
      }),
    fetch: (path, init) =>
      Effect.tryPromise({
        try: () => client.fetch(path, init),
        catch: (cause) => new BridgeInferenceRequestError({
          message: `Tinfoil secure request failed: ${errorMessage(cause)}`,
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
    const modelId = modelIdFromPayload(input.payload);
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

    const response = yield* secureClient.fetch(input.path, {
      body: input.body ?? JSON.stringify(input.payload ?? {}),
      headers,
      method: "POST",
      signal: input.signal,
    });

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
