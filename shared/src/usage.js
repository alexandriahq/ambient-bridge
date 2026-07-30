import { z } from "zod";

export const USAGE_ERROR_CODES = Object.freeze([
  "INSUFFICIENT_CREDIT",
  "PRICING_UNAVAILABLE",
  "RESERVATION_CONFLICT",
  "RESERVATION_NOT_FOUND",
  "USAGE_UNAVAILABLE",
]);

const USD_MICROS_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

const usdMicrosSchema = z.string().regex(USD_MICROS_PATTERN).refine(
  (value) => BigInt(value) <= MAX_POSTGRES_BIGINT,
  "USD micros exceed PostgreSQL BIGINT",
);

const usageOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organization"), id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("user"), id: z.string().min(1).max(200) }),
]);

export const usageSummarySchema = z.object({
  schemaVersion: z.literal(1),
  owner: usageOwnerSchema,
  currency: z.literal("USD"),
  period: z.object({ kind: z.literal("lifetime") }),
  mode: z.enum(["metered", "unlimited"]),
  grantedMicros: usdMicrosSchema,
  usedMicros: usdMicrosSchema,
  reservedMicros: usdMicrosSchema,
  remainingMicros: usdMicrosSchema.nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).superRefine((summary, context) => {
  if (summary.mode === "metered" && summary.remainingMicros === null) {
    context.addIssue({ code: "custom", path: ["remainingMicros"], message: "Metered usage requires remaining credit" });
  }
  if (summary.mode === "unlimited" && summary.remainingMicros !== null) {
    context.addIssue({ code: "custom", path: ["remainingMicros"], message: "Unlimited usage has no finite remaining credit" });
  }
});

const usageApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(USAGE_ERROR_CODES),
    message: z.string().min(1).max(500),
    requestId: z.string().min(1).max(200).optional(),
  }),
  summary: usageSummarySchema.optional(),
});

const usageReservationResponseSchema = z.object({
  reservationId: z.string().min(1).max(200),
  reservedMicros: usdMicrosSchema,
  expiresAt: z.string().datetime({ offset: true }),
  summary: usageSummarySchema,
});

const usageSnapshotSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), summary: usageSummarySchema, fetchedAt: z.string().datetime({ offset: true }) }),
  z.object({ state: z.literal("stale"), summary: usageSummarySchema, fetchedAt: z.string().datetime({ offset: true }) }),
  z.object({
    state: z.literal("unavailable"),
    reason: z.enum(["signed_out", "offline", "server_error", "not_enabled"]),
  }),
]);

export function parseUsageSummary(value) {
  return usageSummarySchema.parse(value);
}

export function parseUsageApiError(value) {
  const parsed = usageApiErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseUsageReservationResponse(value) {
  return usageReservationResponseSchema.parse(value);
}

export function parseUsageSnapshot(value) {
  return usageSnapshotSchema.parse(value);
}

export function usdMicrosBigInt(value) {
  return BigInt(usdMicrosSchema.parse(value));
}

export function formatUsdMicros(value, locale) {
  const micros = usdMicrosBigInt(value);
  const roundedCents = (micros + 5_000n) / 10_000n;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(roundedCents) / 100);
}
