import { z } from "zod";

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
  /** Billing facts (ADR-0243). Absent from servers older than usage billing. */
  readonly billing?: UsageSummaryBilling;
}

export type UsageBillingMode = "usage" | "credits";
export type UsageBillingStatus = "active" | "past_due";
export type UsageSpendingLimitPeriod = "day" | "week" | "month";
/** Why the server would refuse a new inference hold right now. */
export type UsageBillingBlockedReason = "spending_limit" | "past_due" | "needs_payment_method";

export interface UsageSummaryBilling {
  readonly mode: UsageBillingMode;
  /** Spend past prepaid credit is billed to a card right now. */
  readonly meteredActive: boolean;
  readonly blockedReason: UsageBillingBlockedReason | null;
}

export interface UsageSpendingLimit {
  readonly amountMicros: UsdMicros;
  readonly period: UsageSpendingLimitPeriod;
}

/**
 * `GET /usage/billing`: the account that pays for this session's ACC usage.
 * Org sessions resolve to the organization (`scope: "organization"`); only
 * org admins may manage it (`canManage`), and members never see its card.
 */
export interface UsageBillingState {
  readonly schemaVersion: 1;
  readonly owner: UsageOwner;
  readonly scope: "personal" | "organization";
  readonly organization: { readonly id: string; readonly name: string | null } | null;
  readonly canManage: boolean;
  /** Server has Stripe usage billing on; card routes 503 otherwise. */
  readonly usageBillingAvailable: boolean;
  /** Stripe publishable key for the card field; null unless manageable. */
  readonly publishableKey: string | null;
  readonly mode: UsageBillingMode;
  readonly status: UsageBillingStatus;
  readonly meteredActive: boolean;
  readonly paymentMethod: {
    readonly brand: string;
    readonly last4: string;
    readonly expMonth: number | null;
    readonly expYear: number | null;
  } | null;
  readonly spendingLimit: UsageSpendingLimit | null;
  readonly limitWindow: {
    readonly period: UsageSpendingLimitPeriod;
    readonly startsAt: string;
    readonly resetsAt: string;
    readonly spentMicros: UsdMicros;
    readonly heldMicros: UsdMicros;
  } | null;
  /** UTC calendar month; metered share is what Stripe invoices. */
  readonly currentMonth: {
    readonly startsAt: string;
    readonly spentMicros: UsdMicros;
    readonly meteredMicros: UsdMicros;
  };
  readonly blockedReason: UsageBillingBlockedReason | null;
  /** @deprecated The separate portal is retired; Cloud returns null for v1 clients. */
  readonly portalUrl: string | null;
  readonly summary: UsageSummary;
}

/** `POST /usage/billing/setup-intent`: client secret for Stripe Elements card setup. */
export interface UsageBillingSetupIntent {
  readonly schemaVersion: 1;
  readonly setupIntentId: string;
  readonly clientSecret: string;
  readonly publishableKey: string;
}

export const USAGE_ERROR_CODES = Object.freeze([
  "INSUFFICIENT_CREDIT",
  "SPENDING_LIMIT_REACHED",
  "BILLING_PAST_DUE",
  "BILLING_UNAVAILABLE",
  "BILLING_FORBIDDEN",
  "INVALID_BILLING_REQUEST",
  "PRICING_UNAVAILABLE",
  "RESERVATION_CONFLICT",
  "RESERVATION_NOT_FOUND",
  "USAGE_UNAVAILABLE",
  "TOPUP_UNAVAILABLE",
  "INVALID_TOPUP_PACKAGE",
] as const);

export type UsageErrorCode = (typeof USAGE_ERROR_CODES)[number];

export interface UsageApiErrorBody {
  readonly error: {
    readonly code: UsageErrorCode;
    readonly message: string;
    readonly requestId?: string;
  };
  readonly summary?: UsageSummary;
}

/** Fixed credit pack offered through Stripe Checkout. Amounts are USD micros. */
export interface UsageTopupPackage {
  readonly id: string;
  readonly label: string;
  readonly amountCents: number;
  readonly creditMicros: UsdMicros;
}

/**
 * Authenticated top-up catalog. When `enabled` is false the server is not
 * accepting purchases; keys and packages may still be omitted.
 */
export interface UsageTopupOptions {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly mode: "test" | "live" | null;
  readonly publishableKey: string | null;
  readonly packages: readonly UsageTopupPackage[];
  /** Only returned when the caller negotiates custom amounts end-to-end. */
  readonly customAmount?: { readonly minAmountCents: number; readonly maxAmountCents: number };
  /** Customer billing origin when the web portal is deployed; null otherwise. */
  /** @deprecated The separate portal is retired; Cloud returns null for v1 clients. */
  readonly portalUrl?: string | null;
}

export type UsageTopupCheckoutRequest =
  | { readonly packageId: string }
  | { readonly amountCents: number };

export const CUSTOM_TOPUP_MIN_CENTS = 100;
export const CUSTOM_TOPUP_MAX_CENTS = 1_000_000;

/** Exactly one server-priced pack or a USD amount in whole cents. */
export const usageTopupCheckoutRequestSchema: z.ZodType<UsageTopupCheckoutRequest> = z.union([
  z.object({ packageId: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/) }).strict(),
  z.object({ amountCents: z.number().int().min(CUSTOM_TOPUP_MIN_CENTS).max(CUSTOM_TOPUP_MAX_CENTS) }).strict(),
]);

export interface UsageTopupCheckoutResponse {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly checkoutUrl: string;
}

export type InferenceUsageRoute =
  | "/v1/chat/completions"
  | "/v1/responses"
  | "/v1/audio/transcriptions"
  | "/v1/embeddings";

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

/**
 * Public inference price row for clients. Micros stay decimal strings so no
 * transport can round a 64-bit monetary value. The server ledger remains the
 * billing authority for org credit.
 */
export type UsagePriceBilling = "tokens" | "per_request" | "audio_seconds";

export interface UsagePriceRow {
  readonly route: InferenceUsageRoute;
  readonly modelId: string;
  readonly billing: UsagePriceBilling;
  readonly inputMicrosPerMillion: UsdMicros;
  /** Cache-hit input rate; null when the catalog does not split cache tokens. */
  readonly cacheInputMicrosPerMillion?: UsdMicros | null;
  readonly outputMicrosPerMillion: UsdMicros;
  /** Flat fee for `per_request` billing; null for token billing. */
  readonly requestMicros: UsdMicros | null;
  /** Per-minute audio rate for `audio_seconds` billing; null otherwise. */
  readonly audioMicrosPerMinute?: UsdMicros | null;
  readonly reservationMicros: UsdMicros;
}

export interface UsagePricingCatalog {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly prices: readonly UsagePriceRow[];
}

/** One completed inference request from Bridge's in-memory history (app-facing). */
export interface UsageInstanceHistoryEntry {
  readonly requestId: string;
  readonly modelId: string | null;
  readonly route: InferenceUsageRoute;
  readonly status: "active" | "completed" | "failed" | "cancelled";
  readonly statusCode: number | null;
  readonly completedAt: number | null;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  } | null;
}

/**
 * Authoritative org/user per-model rollup from the server credit ledger.
 */
export interface UsageModelBreakdownRow {
  readonly modelId: string;
  readonly route: InferenceUsageRoute;
  readonly requestCount: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** SUM of charge `used_delta_micros` for this model/route. */
  readonly usedMicros: UsdMicros;
}

export interface UsageModelBreakdown {
  readonly schemaVersion: 1;
  readonly owner: UsageOwner;
  readonly currency: "USD";
  readonly period: { readonly kind: "lifetime" };
  readonly rows: readonly UsageModelBreakdownRow[];
  readonly totalUsedMicros: UsdMicros;
  readonly updatedAt: string;
}

const USD_MICROS_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const INFERENCE_USAGE_ROUTES = [
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/audio/transcriptions",
  "/v1/embeddings",
] as const;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;

const usdMicrosSchema = z.string().regex(USD_MICROS_PATTERN).refine(
  (value) => BigInt(value) <= MAX_POSTGRES_BIGINT,
  "USD micros exceed PostgreSQL BIGINT",
);

const usageOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organization"), id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("user"), id: z.string().min(1).max(200) }),
]);

const usageSummaryBillingSchema = z.object({
  mode: z.enum(["usage", "credits"]),
  meteredActive: z.boolean(),
  blockedReason: z.enum(["spending_limit", "past_due", "needs_payment_method"]).nullable(),
});

export const usageSummarySchema: z.ZodType<UsageSummary> = z.object({
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
  billing: usageSummaryBillingSchema.optional(),
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

const TOPUP_PACKAGE_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

const usageTopupPackageSchema = z.object({
  id: z.string().regex(TOPUP_PACKAGE_ID_PATTERN),
  label: z.string().min(1).max(80),
  amountCents: z.number().int().positive().max(1_000_000),
  creditMicros: usdMicrosSchema.refine((value) => BigInt(value) > 0n, "credit must be positive"),
}).strict();

export const usageTopupOptionsSchema: z.ZodType<UsageTopupOptions> = z.object({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  mode: z.enum(["test", "live"]).nullable(),
  publishableKey: z.string().min(1).max(200).nullable(),
  packages: z.array(usageTopupPackageSchema).max(20),
  customAmount: z.object({
    minAmountCents: z.number().int().min(CUSTOM_TOPUP_MIN_CENTS),
    maxAmountCents: z.number().int().max(CUSTOM_TOPUP_MAX_CENTS),
  }).strict().refine((range) => range.minAmountCents <= range.maxAmountCents).optional(),
  portalUrl: z.string().url().max(2_000).nullable().optional(),
}).strict();

export const usageTopupCheckoutResponseSchema: z.ZodType<UsageTopupCheckoutResponse> = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1).max(200),
  checkoutUrl: z.string().url().max(2_000),
}).strict();

const usagePriceRowSchema = z.object({
  route: z.enum(INFERENCE_USAGE_ROUTES),
  modelId: z.string().regex(MODEL_ID_PATTERN),
  billing: z.enum(["tokens", "per_request", "audio_seconds"]),
  inputMicrosPerMillion: usdMicrosSchema,
  cacheInputMicrosPerMillion: usdMicrosSchema.nullable().optional(),
  outputMicrosPerMillion: usdMicrosSchema,
  requestMicros: usdMicrosSchema.nullable(),
  audioMicrosPerMinute: usdMicrosSchema.nullable().optional(),
  reservationMicros: usdMicrosSchema,
}).strict().superRefine((row, context) => {
  if (row.billing === "per_request") {
    if (row.requestMicros === null || BigInt(row.requestMicros) <= 0n) {
      context.addIssue({
        code: "custom",
        path: ["requestMicros"],
        message: "per_request billing requires a positive requestMicros",
      });
    }
    if (row.audioMicrosPerMinute != null) {
      context.addIssue({
        code: "custom",
        path: ["audioMicrosPerMinute"],
        message: "per_request billing must set audioMicrosPerMinute to null",
      });
    }
  } else if (row.billing === "audio_seconds") {
    if (row.route !== "/v1/audio/transcriptions") {
      context.addIssue({
        code: "custom",
        path: ["route"],
        message: "audio_seconds billing requires the audio transcription route",
      });
    }
    if (row.requestMicros !== null) {
      context.addIssue({
        code: "custom",
        path: ["requestMicros"],
        message: "audio_seconds billing must set requestMicros to null",
      });
    }
    if (row.audioMicrosPerMinute == null || BigInt(row.audioMicrosPerMinute) <= 0n) {
      context.addIssue({
        code: "custom",
        path: ["audioMicrosPerMinute"],
        message: "audio_seconds billing requires a positive audioMicrosPerMinute",
      });
    }
    if (row.inputMicrosPerMillion !== "0" || row.outputMicrosPerMillion !== "0") {
      context.addIssue({
        code: "custom",
        path: ["inputMicrosPerMillion"],
        message: "audio_seconds billing must set token rates to zero",
      });
    }
  } else {
    if (row.requestMicros !== null) {
      context.addIssue({
        code: "custom",
        path: ["requestMicros"],
        message: "token billing must set requestMicros to null",
      });
    }
    if (row.audioMicrosPerMinute != null) {
      context.addIssue({
        code: "custom",
        path: ["audioMicrosPerMinute"],
        message: "token billing must set audioMicrosPerMinute to null",
      });
    }
  }
});

export const usagePricingCatalogSchema: z.ZodType<UsagePricingCatalog> = z.object({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
  prices: z.array(usagePriceRowSchema).min(1).max(500),
}).strict();

const usageInstanceHistoryEntrySchema = z.object({
  requestId: z.string().min(1).max(200),
  modelId: z.string().regex(MODEL_ID_PATTERN).nullable(),
  route: z.enum(INFERENCE_USAGE_ROUTES),
  status: z.enum(["active", "completed", "failed", "cancelled"]),
  statusCode: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
  usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }).strict().nullable(),
}).strict();

const usageModelBreakdownRowSchema = z.object({
  modelId: z.string().regex(MODEL_ID_PATTERN),
  route: z.enum(INFERENCE_USAGE_ROUTES),
  requestCount: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  usedMicros: usdMicrosSchema,
}).strict();

export const usageModelBreakdownSchema: z.ZodType<UsageModelBreakdown> = z.object({
  schemaVersion: z.literal(1),
  owner: usageOwnerSchema,
  currency: z.literal("USD"),
  period: z.object({ kind: z.literal("lifetime") }),
  rows: z.array(usageModelBreakdownRowSchema).max(500),
  totalUsedMicros: usdMicrosSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

const spendingLimitPeriodSchema = z.enum(["day", "week", "month"]);
const isoDateTime = z.string().datetime({ offset: true });

export const usageBillingStateSchema: z.ZodType<UsageBillingState> = z.object({
  schemaVersion: z.literal(1),
  owner: usageOwnerSchema,
  scope: z.enum(["personal", "organization"]),
  organization: z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200).nullable() }).nullable(),
  canManage: z.boolean(),
  usageBillingAvailable: z.boolean(),
  publishableKey: z.string().regex(/^pk_(test|live)_[A-Za-z0-9_]+$/).max(300).nullable(),
  mode: z.enum(["usage", "credits"]),
  status: z.enum(["active", "past_due"]),
  meteredActive: z.boolean(),
  paymentMethod: z.object({
    brand: z.string().min(1).max(60),
    last4: z.string().regex(/^[0-9]{4}$/),
    expMonth: z.number().int().min(1).max(12).nullable(),
    expYear: z.number().int().min(2000).max(9999).nullable(),
  }).nullable(),
  spendingLimit: z.object({ amountMicros: usdMicrosSchema, period: spendingLimitPeriodSchema }).nullable(),
  limitWindow: z.object({
    period: spendingLimitPeriodSchema,
    startsAt: isoDateTime,
    resetsAt: isoDateTime,
    spentMicros: usdMicrosSchema,
    heldMicros: usdMicrosSchema,
  }).nullable(),
  currentMonth: z.object({ startsAt: isoDateTime, spentMicros: usdMicrosSchema, meteredMicros: usdMicrosSchema }),
  blockedReason: z.enum(["spending_limit", "past_due", "needs_payment_method"]).nullable(),
  portalUrl: z.string().url().max(2_000).nullable(),
  summary: usageSummarySchema,
});

export const usageBillingSetupIntentSchema: z.ZodType<UsageBillingSetupIntent> = z.object({
  schemaVersion: z.literal(1),
  setupIntentId: z.string().regex(/^seti_[A-Za-z0-9_]{1,200}$/),
  clientSecret: z.string().regex(/^seti_[A-Za-z0-9_]+_secret_[A-Za-z0-9_]+$/).max(500),
  publishableKey: z.string().regex(/^pk_(test|live)_[A-Za-z0-9_]+$/).max(300),
}).strict();

export function parseUsageBillingState(value: unknown): UsageBillingState {
  return usageBillingStateSchema.parse(value);
}

export function parseUsageBillingSetupIntent(value: unknown): UsageBillingSetupIntent {
  return usageBillingSetupIntentSchema.parse(value);
}

/** `$12.50` → "12500000"; null for anything that is not a positive amount with ≤ 2 decimals. */
export function usdInputToMicros(value: string): UsdMicros | null {
  const cleaned = value.replace(/[$,\s]/g, "");
  const match = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) return null;
  const micros = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(2, "0") || "0") * 10_000n;
  return micros > 0n ? micros.toString() : null;
}

export function parseUsageSummary(value: unknown): UsageSummary {
  return usageSummarySchema.parse(value);
}

export function parseUsageApiError(value: unknown): UsageApiErrorBody | null {
  const parsed = usageApiErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseUsageReservationResponse(value: unknown): UsageReservationResponse {
  return usageReservationResponseSchema.parse(value);
}

export function parseUsageSnapshot(value: unknown): UsageSnapshot {
  return usageSnapshotSchema.parse(value);
}

export function parseUsageTopupOptions(value: unknown): UsageTopupOptions {
  return usageTopupOptionsSchema.parse(value);
}

export function parseUsageTopupCheckoutResponse(value: unknown): UsageTopupCheckoutResponse {
  return usageTopupCheckoutResponseSchema.parse(value);
}

export function parseUsagePricingCatalog(value: unknown): UsagePricingCatalog {
  return usagePricingCatalogSchema.parse(value);
}

export function parseUsageInstanceHistoryEntry(value: unknown): UsageInstanceHistoryEntry {
  return usageInstanceHistoryEntrySchema.parse(value);
}

export function parseUsageModelBreakdown(value: unknown): UsageModelBreakdown {
  return usageModelBreakdownSchema.parse(value);
}

export function usdMicrosBigInt(value: UsdMicros): bigint {
  return BigInt(usdMicrosSchema.parse(value));
}

export function formatUsdMicros(value: UsdMicros, locale?: string): string {
  const micros = usdMicrosBigInt(value);
  const roundedCents = (micros + 5_000n) / 10_000n;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(roundedCents) / 100);
}
