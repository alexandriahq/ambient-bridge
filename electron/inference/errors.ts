import type { UsageSummary } from "@ambient/shared/usage";

export type BridgeUpstreamErrorCode =
  | "UPSTREAM_BILLING_UNAVAILABLE"
  | "UPSTREAM_ENVELOPE_UNAVAILABLE";

export class BridgeInsufficientCreditError extends Error {
  readonly code = "INSUFFICIENT_CREDIT" as const;
  readonly source = "ambient_account" as const;

  constructor(
    readonly summary?: UsageSummary,
    readonly httpStatus = 402,
  ) {
    super("Ambient inference credit is exhausted.");
    this.name = "BridgeInsufficientCreditError";
  }
}

export class BridgeInferenceServiceError extends Error {
  readonly source = "tinfoil_provider" as const;

  constructor(
    readonly code: BridgeUpstreamErrorCode,
    readonly httpStatus: number,
    readonly retryAfterSeconds: number,
  ) {
    super(`Inference processing is temporarily unavailable. (${code})`);
    this.name = "BridgeInferenceServiceError";
  }
}

export class BridgeUsageRequestError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "BridgeUsageRequestError";
  }
}

export type BridgeInferenceDomainError = BridgeInsufficientCreditError | BridgeInferenceServiceError;

export function inferenceDomainError(error: unknown, depth = 0): BridgeInferenceDomainError | null {
  if (error instanceof BridgeInsufficientCreditError || error instanceof BridgeInferenceServiceError) return error;
  if (depth > 6 || !error || typeof error !== "object") return errorFromStableMessage(error);
  const record = error as { readonly cause?: unknown; readonly message?: unknown };
  return inferenceDomainError(record.cause, depth + 1) ?? errorFromStableMessage(record.message);
}

export function inferenceIpcErrorCode(error: unknown): string | null {
  return inferenceDomainError(error)?.code ?? null;
}

function errorFromStableMessage(value: unknown): BridgeInferenceDomainError | null {
  if (typeof value !== "string") return null;
  if (value.includes("UPSTREAM_BILLING_UNAVAILABLE")) {
    return new BridgeInferenceServiceError("UPSTREAM_BILLING_UNAVAILABLE", 503, 60);
  }
  if (value.includes("UPSTREAM_ENVELOPE_UNAVAILABLE")) {
    return new BridgeInferenceServiceError("UPSTREAM_ENVELOPE_UNAVAILABLE", 503, 30);
  }
  if (value.includes("INSUFFICIENT_CREDIT")) return new BridgeInsufficientCreditError();
  return null;
}

export function boundedRetryAfterSeconds(value: string | null, fallback: number): number {
  if (!value || !/^\d{1,5}$/.test(value)) return fallback;
  return Math.max(1, Math.min(300, Number(value)));
}
