import { Effect } from "effect";
import type { UsageReservationResponse, UsageSummary } from "@ambient/shared/usage";
import { AuthServerClient, AuthServerUsageError } from "../auth/server-client.js";
import type { SignedInWorkOsSession } from "../workos/session.js";
import { errorMessage } from "../error-message.js";
import {
  BridgeInferenceServiceError,
  BridgeInsufficientCreditError,
  BridgeUsageRequestError,
} from "./errors.js";
import type { InferenceProxyPath } from "./effect.js";

export interface BridgeUsageService {
  readonly summary: (session: SignedInWorkOsSession) => Promise<UsageSummary>;
  readonly reserve: (input: {
    readonly session: SignedInWorkOsSession;
    readonly requestId: string;
    readonly route: InferenceProxyPath;
    readonly modelId: string;
  }) => Effect.Effect<
    UsageReservationResponse,
    BridgeInferenceServiceError
      | BridgeInsufficientCreditError
      | BridgeUsageAccountingDisabledError
      | BridgeUsageRequestError
  >;
  readonly release: (
    session: SignedInWorkOsSession,
    reservationId: string,
  ) => Effect.Effect<void, BridgeUsageRequestError>;
}

export class BridgeUsageAccountingDisabledError extends Error {
  constructor() {
    super("Inference usage accounting is disabled.");
    this.name = "BridgeUsageAccountingDisabledError";
  }
}

export function createBridgeUsageService(client: AuthServerClient): BridgeUsageService {
  return {
    summary: (session) => client.usageSummary(session.sessionToken),
    reserve: (input) => Effect.tryPromise({
      try: () => client.reserveUsage(input.session.sessionToken, {
        requestId: input.requestId,
        route: input.route,
        modelId: input.modelId,
      }),
      catch: (cause) => {
        if (cause instanceof AuthServerUsageError && cause.code === "INSUFFICIENT_CREDIT") {
          return new BridgeInsufficientCreditError(cause.summary, cause.status);
        }
        if (cause instanceof AuthServerUsageError
          && cause.code === "USAGE_UNAVAILABLE"
          && cause.status === 503) {
          return new BridgeUsageAccountingDisabledError();
        }
        if (cause instanceof AuthServerUsageError && cause.code === "USAGE_UNAVAILABLE" && cause.status >= 500) {
          return new BridgeInferenceServiceError("UPSTREAM_BILLING_UNAVAILABLE", cause.status, 60);
        }
        return new BridgeUsageRequestError(`Inference credit reservation failed: ${safeUsageError(cause)}`, cause);
      },
    }),
    release: (session, reservationId) => Effect.tryPromise({
      try: async () => { await client.releaseUsage(session.sessionToken, reservationId); },
      catch: (cause) => new BridgeUsageRequestError(
        `Inference credit reservation release failed: ${safeUsageError(cause)}`,
        cause,
      ),
    }),
  };
}

function safeUsageError(error: unknown): string {
  if (error instanceof AuthServerUsageError) return error.code;
  return errorMessage(error).slice(0, 160);
}
