import type { z } from "zod";

/**
 * Canonical base-10 integer USD micros. One USD is exactly 1,000,000 micros.
 * JSON uses strings so no transport can round a 64-bit monetary value.
 */
export type UsdMicros = string;

export type UsageOwner =
  | { readonly kind: "organization"; readonly id: string }
  | { readonly kind: "user"; readonly id: string };

export interface UsageSummary {
  readonly schemaVersion: 1;
  readonly owner: UsageOwner;
  readonly currency: "USD";
  readonly period: { readonly kind: "lifetime" };
  readonly mode: "metered" | "unlimited";
  readonly grantedMicros: UsdMicros;
  readonly usedMicros: UsdMicros;
  readonly reservedMicros: UsdMicros;
  readonly remainingMicros: UsdMicros | null;
  readonly updatedAt: string;
}

export declare const USAGE_ERROR_CODES: readonly [
  "INSUFFICIENT_CREDIT",
  "PRICING_UNAVAILABLE",
  "RESERVATION_CONFLICT",
  "RESERVATION_NOT_FOUND",
  "USAGE_UNAVAILABLE",
];

export type UsageErrorCode = typeof USAGE_ERROR_CODES[number];

export interface UsageApiErrorBody {
  readonly error: {
    readonly code: UsageErrorCode;
    readonly message: string;
    readonly requestId?: string;
  };
  readonly summary?: UsageSummary;
}

export type InferenceUsageRoute =
  | "/v1/chat/completions"
  | "/v1/responses"
  | "/v1/audio/transcriptions";

export interface UsageReservationRequest {
  readonly requestId: string;
  readonly route: InferenceUsageRoute;
  readonly modelId: string;
}

export interface UsageReservationResponse {
  readonly reservationId: string;
  readonly reservedMicros: UsdMicros;
  readonly expiresAt: string;
  readonly summary: UsageSummary;
}

export type UsageSnapshot =
  | {
      readonly state: "ready" | "stale";
      readonly summary: UsageSummary;
      readonly fetchedAt: string;
    }
  | {
      readonly state: "unavailable";
      readonly reason: "signed_out" | "offline" | "server_error" | "not_enabled";
    };

export declare const usageSummarySchema: z.ZodType<UsageSummary>;

export declare function parseUsageSummary(value: unknown): UsageSummary;
export declare function parseUsageApiError(value: unknown): UsageApiErrorBody | null;
export declare function parseUsageReservationResponse(value: unknown): UsageReservationResponse;
export declare function parseUsageSnapshot(value: unknown): UsageSnapshot;
export declare function usdMicrosBigInt(value: UsdMicros): bigint;
export declare function formatUsdMicros(value: UsdMicros, locale?: string): string;
