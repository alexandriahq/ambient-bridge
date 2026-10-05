import { Data } from "effect";
import type { UsageSummary } from "@ambient/shared/usage";
import { parseGloballyDisabledMessage } from "@alexandria/cloud-contract";

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
    super(summary?.mode === "metered"
      ? "Ambient inference credit is exhausted."
      : "AI processing is unavailable for this account. (INSUFFICIENT_CREDIT)");
    this.name = "BridgeInsufficientCreditError";
  }
}

export class BridgeInferenceServiceError extends Data.TaggedError("BridgeInferenceServiceError")<{ readonly message: string }> {
  readonly source: "tinfoil_provider" | "openrouter_provider";

  constructor(
    readonly code: BridgeUpstreamErrorCode,
    readonly httpStatus: number,
    readonly retryAfterSeconds: number,
    source: "tinfoil_provider" | "openrouter_provider" = "tinfoil_provider",
  ) {
    super({ message: code === "UPSTREAM_BILLING_UNAVAILABLE"
      ? "AI processing is temporarily unavailable. Try again shortly; if this continues, contact Ambient support. (UPSTREAM_BILLING_UNAVAILABLE)"
      : `Inference processing is temporarily unavailable. (${code})` });
    this.source = source;
    this.name = "BridgeInferenceServiceError";
  }
}

export class BridgeUsageRequestError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "BridgeUsageRequestError";
  }
}

/**
 * Cloud refused a globally disabled provider or model (ADR-0296). A
 * per-request refusal, not an account or service state: it never trips the
 * availability circuit. The message keeps the `globally_disabled:` prefix so
 * the app can show the text after it; `code` is the shipped `policy_denied`.
 */
export class BridgeGloballyDisabledError extends Error {
  readonly code = "policy_denied" as const;

  constructor(message: string, readonly httpStatus = 403) {
    super(message);
    this.name = "BridgeGloballyDisabledError";
  }
}

/**
 * Readable text of a global-control refusal (ADR-0296): a Node grant refused
 * with `policy_denied` + `globally_disabled:` (any error carrying that code),
 * or the legacy reservation refusal. null for every other error.
 */
export function globallyDisabledRefusalText(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { readonly code?: unknown; readonly message?: unknown };
  if (record.code !== "policy_denied" || typeof record.message !== "string") return null;
  return parseGloballyDisabledMessage(record.message);
}

export type BridgeInferenceDomainError = BridgeInsufficientCreditError | BridgeInferenceServiceError;

export function inferenceDomainError(error: unknown, depth = 0): BridgeInferenceDomainError | null {
  if (error instanceof BridgeInsufficientCreditError || error instanceof BridgeInferenceServiceError) return error;
  if (depth > 6 || !error || typeof error !== "object") return errorFromStableMessage(error);
  const record = error as { readonly cause?: unknown; readonly message?: unknown };
  return inferenceDomainError(record.cause, depth + 1) ?? errorFromStableMessage(record.message);
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

/** Classify trusted gateway markers before a plaintext response can close the circuit. */
export function inferenceResponseDomainError(response: Response): BridgeInferenceDomainError | null {
  if (response.ok) return null;
  const code = response.headers.get("x-ambient-error-code");
  const source = response.headers.get("x-ambient-error-source");
  if (code === "INSUFFICIENT_CREDIT" && source === "ambient_account") {
    return new BridgeInsufficientCreditError(undefined, response.status);
  }
  if (code === "UPSTREAM_BILLING_UNAVAILABLE" || code === "UPSTREAM_ENVELOPE_UNAVAILABLE") {
    return new BridgeInferenceServiceError(code, response.status,
      boundedRetryAfterSeconds(response.headers.get("retry-after"), code === "UPSTREAM_BILLING_UNAVAILABLE" ? 60 : 30),
      source === "openrouter_provider" ? source : "tinfoil_provider");
  }
  return null;
}
