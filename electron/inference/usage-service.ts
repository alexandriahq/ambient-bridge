import { Effect } from "effect";
import type { UsageReservationResponse, UsageSummary } from "@ambient/shared/usage";
import { GLOBALLY_DISABLED_PREFIX } from "@alexandria/cloud-contract";
import { AuthServerClient, AuthServerUsageError } from "../auth/server-client.js";
import type { SignedInWorkOsSession } from "../workos/session.js";
import { errorMessage } from "../error-message.js";
import {
  BridgeGloballyDisabledError,
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
      | BridgeGloballyDisabledError
      | BridgeInsufficientCreditError
      | BridgeUsageAccountingDisabledError
      | BridgeUsageRequestError
  >;
  readonly release: (
    session: SignedInWorkOsSession,
    reservationId: string,
  ) => Effect.Effect<void, BridgeUsageRequestError>;
}

/** Account-side refusals: the account cannot pay right now (ADR-0243). */
const ACCOUNT_REFUSAL_CODES: ReadonlySet<string> = new Set(["INSUFFICIENT_CREDIT", "SPENDING_LIMIT_REACHED", "BILLING_PAST_DUE"]);

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
        if (cause instanceof AuthServerUsageError && ACCOUNT_REFUSAL_CODES.has(cause.code)) {
          return new BridgeInsufficientCreditError(cause.summary, cause.status);
        }
        if (isGloballyDisabledUsageError(cause)) {
          return new BridgeGloballyDisabledError(cause.serverMessage.slice(0, 400), cause.status);
        }
        if (cause instanceof AuthServerUsageError
          && cause.code === "USAGE_UNAVAILABLE"
          && cause.status === 503) {
          return new BridgeUsageAccountingDisabledError();
        }
        if (cause instanceof AuthServerUsageError && cause.code === "USAGE_UNAVAILABLE" && cause.status >= 500) {
          return new BridgeInferenceServiceError("UPSTREAM_BILLING_UNAVAILABLE", cause.status, 60);
        }
        return new BridgeUsageRequestError(`Inference authorization failed: ${safeUsageError(cause)}`, cause);
      },
    }),
    release: (session, reservationId) => Effect.tryPromise({
      try: async () => { await client.releaseUsage(session.sessionToken, reservationId); },
      catch: (cause) => new BridgeUsageRequestError(
        `Inference authorization cleanup failed: ${safeUsageError(cause)}`,
        cause,
      ),
    }),
  };
}

/** Legacy `/usage/reservations` refusal of a globally disabled provider or model (ADR-0296). */
export function isGloballyDisabledUsageError(error: unknown): error is AuthServerUsageError {
  return error instanceof AuthServerUsageError
    && error.code === "BILLING_FORBIDDEN"
    && error.serverMessage.startsWith(GLOBALLY_DISABLED_PREFIX);
}

function safeUsageError(error: unknown): string {
  if (error instanceof AuthServerUsageError) return error.code;
  return errorMessage(error).slice(0, 160);
}
