import { z } from "zod";

// Operator wire shapes for an organization's commercial side: billing plan,
// seats, members, usage analytics, request metadata, and Stripe. Served by
// Alexandria Cloud under `/admin/organizations/:orgId/*` to the Alexandria
// console, same operator gate as org policy. Money is integer USD micros as a
// decimal string. Usage is metadata only: no prompt, completion, or capture
// content ever reaches these shapes.

const id = z.string().trim().min(1).max(200);
const reason = z.string().trim().min(3).max(1000);
const micros = z.string().regex(/^(0|[1-9][0-9]*)$/);
const signedMicros = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();

// ---------------------------------------------------------------------------
// Billing plan
// ---------------------------------------------------------------------------

/**
 * Operator-facing billing plan for an organization.
 * - `contract`: invoiced outside the product (signed contract); usage is capped
 *   by limits and prepaid credit. The common enterprise case.
 * - `usage`: card on file, metered monthly through Stripe.
 * - `unlimited`: no caps, no charges (internal, design partners).
 */
export const BILLING_PLANS = ["contract", "usage", "unlimited"] as const;
export const billingPlanSchema = z.enum(BILLING_PLANS);
export type BillingPlan = z.infer<typeof billingPlanSchema>;

export const LIMIT_PERIODS = ["day", "week", "month"] as const;
export const limitSchema = z.object({
  amountMicros: micros,
  period: z.enum(LIMIT_PERIODS),
}).strict();
export type SpendLimit = z.infer<typeof limitSchema>;

export const billingStateSchema = z.object({
  plan: billingPlanSchema,
  /** Org-wide spend cap. null = none (usage plan still bounded by the card). */
  orgLimit: limitSchema.nullable(),
  /** Cap per member. null = none. */
  memberLimit: limitSchema.nullable(),
  /** Prepaid credit the org still has. null when unlimited. */
  creditRemainingMicros: micros.nullable(),
  creditGrantedMicros: micros,
  creditUsedMicros: micros,
  status: z.enum(["active", "past_due", "suspended"]),
  /** Why requests are being refused right now, if they are. */
  blockedReason: z.enum(["org_limit", "credit_exhausted", "past_due", "suspended", "no_payment_method"]).nullable(),
  spend: z.object({
    todayMicros: micros,
    monthMicros: micros,
    meteredMonthMicros: micros,
  }).strict(),
  stripe: z.object({
    customerId: z.string().nullable(),
    subscriptionId: z.string().nullable(),
    paymentMethod: z.object({ brand: z.string(), last4: z.string() }).strict().nullable(),
  }).strict(),
  updatedAt: isoDateTime.nullable(),
}).strict();
export type BillingState = z.infer<typeof billingStateSchema>;

/** PUT /admin/organizations/:orgId/billing */
export const updateBillingRequestSchema = z.object({
  plan: billingPlanSchema,
  orgLimit: limitSchema.nullable(),
  memberLimit: limitSchema.nullable(),
  reason,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
}).strict();

/** POST /admin/organizations/:orgId/billing/credits */
export const creditAdjustmentRequestSchema = z.object({
  kind: z.enum(["grant", "adjustment"]),
  /** Positive for grant; signed for adjustment. */
  amountMicros: signedMicros,
  reason,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
}).strict();

export const ledgerEntrySchema = z.object({
  id,
  type: z.enum(["grant", "adjustment", "charge", "refund", "unlimited_enabled", "unlimited_disabled", "plan_changed", "limit_changed"]),
  amountMicros: signedMicros,
  /** Charges: model + route that were billed. */
  model: z.string().nullable(),
  route: z.string().nullable(),
  workosUserId: z.string().nullable(),
  actor: z.object({ type: z.enum(["system", "operator", "admin"]), id: z.string().nullable() }).strict(),
  reason: z.string().nullable(),
  createdAt: isoDateTime,
}).strict();
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

/** GET /admin/organizations/:orgId/billing/ledger?cursor=&limit=&types= */
export const ledgerPageSchema = z.object({
  entries: z.array(ledgerEntrySchema),
  nextCursor: z.string().nullable(),
}).strict();

// ---------------------------------------------------------------------------
// Seats and members
// ---------------------------------------------------------------------------

export const SEAT_ENFORCEMENT = ["track", "block"] as const;

export const seatPolicySchema = z.object({
  /** Contracted seats. null = no seat contract. */
  seats: z.number().int().nonnegative().max(1_000_000).nullable(),
  /** `track`: report over-use only. `block`: members beyond the seat count cannot start Ambient. */
  enforcement: z.enum(SEAT_ENFORCEMENT),
}).strict();
export type SeatPolicy = z.infer<typeof seatPolicySchema>;

export const memberSchema = z.object({
  workosUserId: id,
  email: z.string().nullable(),
  name: z.string().nullable(),
  role: z.enum(["admin", "member", "super-admin"]),
  status: z.enum(["active", "pending", "inactive"]),
  /** Holds a seat (counted against `seats`). */
  seated: z.boolean(),
  lastSignInAt: isoDateTime.nullable(),
  /** Last time any of this member's desktops talked to Cloud. */
  lastActiveAt: isoDateTime.nullable(),
  firstActiveAt: isoDateTime.nullable(),
  appVersion: z.string().nullable(),
  spend: z.object({ todayMicros: micros, monthMicros: micros }).strict(),
  requestsMonth: z.number().int().nonnegative(),
}).strict();
export type Member = z.infer<typeof memberSchema>;

/** GET /admin/organizations/:orgId/members */
export const membersResponseSchema = z.object({
  seatPolicy: seatPolicySchema,
  seatsUsed: z.number().int().nonnegative(),
  members: z.array(memberSchema),
}).strict();

/** PUT /admin/organizations/:orgId/seats */
export const updateSeatsRequestSchema = z.object({
  seatPolicy: seatPolicySchema,
  reason,
}).strict();

// ---------------------------------------------------------------------------
// Usage analytics (metadata only)
// ---------------------------------------------------------------------------

export const USAGE_GROUPS = ["day", "member", "model", "route"] as const;
export const usageBucketSchema = z.object({
  key: z.string(),
  /** Display label (member email, model name, date). */
  label: z.string(),
  requests: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  audioSeconds: z.number().nonnegative(),
  costMicros: micros,
  p50LatencyMs: z.number().int().nonnegative().nullable(),
  p95LatencyMs: z.number().int().nonnegative().nullable(),
}).strict();
export type UsageBucket = z.infer<typeof usageBucketSchema>;

/** GET /admin/organizations/:orgId/usage?from=&to=&groupBy= */
export const usageReportSchema = z.object({
  from: isoDate,
  to: isoDate,
  groupBy: z.enum(USAGE_GROUPS),
  totals: usageBucketSchema.omit({ key: true, label: true }),
  buckets: z.array(usageBucketSchema),
  /** Data before this instant has no per-request rows (attribution started then). */
  attributionSince: isoDateTime.nullable(),
}).strict();
export type UsageReport = z.infer<typeof usageReportSchema>;

export const REQUEST_STATUSES = ["reserved", "succeeded", "failed", "cancelled", "expired"] as const;
export const requestRecordSchema = z.object({
  id,
  startedAt: isoDateTime,
  completedAt: isoDateTime.nullable(),
  status: z.enum(REQUEST_STATUSES),
  workosUserId: z.string().nullable(),
  memberEmail: z.string().nullable(),
  installationId: z.string().nullable(),
  /** `alexandria` = cognitive compute (Alexandria Node / confidential); others = third-party relay. */
  provider: z.string(),
  mode: z.enum(["confidential", "plaintext"]).nullable(),
  route: z.string(),
  model: z.string(),
  feature: z.string().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  audioSeconds: z.number().nonnegative().nullable(),
  reservedMicros: micros,
  costMicros: micros.nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  /** Safe error code only; never upstream text. */
  errorCode: z.string().nullable(),
  appVersion: z.string().nullable(),
  pricingVersion: z.string().nullable(),
}).strict();
export type RequestRecord = z.infer<typeof requestRecordSchema>;

/** GET /admin/organizations/:orgId/usage/requests?cursor=&limit=&member=&model=&status=&from=&to= */
export const requestPageSchema = z.object({
  requests: z.array(requestRecordSchema),
  nextCursor: z.string().nullable(),
}).strict();

// ---------------------------------------------------------------------------
// Live dashboard
// ---------------------------------------------------------------------------

/** GET /admin/organizations/:orgId/dashboard */
export const orgDashboardSchema = z.object({
  generatedAt: isoDateTime,
  people: z.object({
    /** Members with desktop activity in the last 5 minutes. */
    liveNow: z.number().int().nonnegative(),
    activeToday: z.number().int().nonnegative(),
    activeWeek: z.number().int().nonnegative(),
    members: z.number().int().nonnegative(),
    seats: z.number().int().nonnegative().nullable(),
  }).strict(),
  requests: z.object({
    lastHour: z.number().int().nonnegative(),
    today: z.number().int().nonnegative(),
    week: z.number().int().nonnegative(),
    failedToday: z.number().int().nonnegative(),
  }).strict(),
  spend: z.object({ todayMicros: micros, weekMicros: micros, monthMicros: micros }).strict(),
  /** Hourly series for the last 24h. */
  hourly: z.array(z.object({ hour: isoDateTime, requests: z.number().int().nonnegative(), activeMembers: z.number().int().nonnegative(), costMicros: micros }).strict()),
  topMembers: z.array(z.object({ workosUserId: id, label: z.string(), requests: z.number().int().nonnegative(), costMicros: micros, lastActiveAt: isoDateTime.nullable() }).strict()),
  topModels: z.array(z.object({ model: z.string(), requests: z.number().int().nonnegative(), costMicros: micros }).strict()),
  billing: z.object({ plan: billingPlanSchema, blockedReason: billingStateSchema.shape.blockedReason }).strict(),
  /**
   * First per-request row for the org; per-person numbers before it are not
   * recorded. Optional on input so a console can read a Cloud that predates it.
   */
  attributionSince: isoDateTime.nullable().optional(),
}).strict();
export type OrgDashboard = z.infer<typeof orgDashboardSchema>;

// ---------------------------------------------------------------------------
// Activity: who is using Ambient right now, and their sessions
// ---------------------------------------------------------------------------

/** A member counts as live when a desktop talked to Cloud within this window. */
export const ACTIVITY_LIVE_WINDOW_MINUTES = 5;
/** Request stats on the live list cover this trailing window. */
export const ACTIVITY_RECENT_WINDOW_MINUTES = 15;
/** A new session starts when one desktop is quiet for longer than this. */
export const ACTIVITY_SESSION_GAP_MINUTES = 30;

export const livePersonSchema = z.object({
  workosUserId: id,
  /** Email, else name, else the user id. */
  label: z.string(),
  email: z.string().nullable(),
  installationId: z.string().nullable(),
  appVersion: z.string().nullable(),
  /** Last time any desktop of this member talked to Cloud. */
  lastSeenAt: isoDateTime,
  /** Last inference request; null when only the desktop heartbeat was seen. */
  lastRequestAt: isoDateTime.nullable(),
  /** Trailing `ACTIVITY_RECENT_WINDOW_MINUTES`. */
  recent: z.object({
    requests: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    costMicros: micros,
    topModel: z.string().nullable(),
  }).strict(),
}).strict();
export type LivePerson = z.infer<typeof livePersonSchema>;

/** GET /admin/organizations/:orgId/activity/live — newest activity first. */
export const liveActivitySchema = z.object({
  generatedAt: isoDateTime,
  people: z.array(livePersonSchema),
}).strict();
export type LiveActivity = z.infer<typeof liveActivitySchema>;

export const activitySessionSchema = z.object({
  /** Opaque, stable for a given member + desktop + start. */
  id,
  workosUserId: id,
  label: z.string(),
  email: z.string().nullable(),
  installationId: z.string().nullable(),
  startedAt: isoDateTime,
  /** null while the session can still continue (quiet for less than the gap). */
  endedAt: isoDateTime.nullable(),
  lastRequestAt: isoDateTime,
  /** First request start to last request end. */
  durationMs: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  costMicros: micros,
  /** Most used first, at most three. */
  models: z.array(z.object({ model: z.string(), requests: z.number().int().nonnegative() }).strict()).max(3),
  appVersion: z.string().nullable(),
}).strict();
export type ActivitySession = z.infer<typeof activitySessionSchema>;

/**
 * GET /admin/organizations/:orgId/activity/sessions?from=&to=&member=&cursor=&limit=
 * Sessions that started in [from, to), newest first. `from`/`to` are dates
 * (whole UTC days) or ISO timestamps; default the last 7 days.
 */
export const activitySessionPageSchema = z.object({
  from: isoDateTime,
  to: isoDateTime,
  gapMinutes: z.number().int().positive(),
  sessions: z.array(activitySessionSchema),
  nextCursor: z.string().nullable(),
  attributionSince: isoDateTime.nullable(),
}).strict();
export type ActivitySessionPage = z.infer<typeof activitySessionPageSchema>;

// ---------------------------------------------------------------------------
// Global: every organization at once (operator dashboard, live list, audit)
// ---------------------------------------------------------------------------

export const GLOBAL_DASHBOARD_RANGES = ["24h", "7d", "30d"] as const;
export const globalDashboardRangeSchema = z.enum(GLOBAL_DASHBOARD_RANGES);
export type GlobalDashboardRange = z.infer<typeof globalDashboardRangeSchema>;
/** Organizations broken out in the time series; the rest are summed under `other`. */
export const GLOBAL_SERIES_ORGANIZATIONS = 5;
/** The request-log provider id of Alexandria cognitive compute (Alexandria Nodes). */
export const COGNITIVE_COMPUTE_PROVIDER = "alexandria";

const count = z.number().int().nonnegative();
const share = z.number().min(0).max(1);

export const globalSeriesKeySchema = z.object({
  /** Organization id, `none` (requests with no organization), or `other`. */
  key: id,
  label: z.string(),
  /** Set when the key is one organization. */
  orgId: id.nullable(),
}).strict();

export const globalSeriesPointSchema = z.object({
  /** Bucket start (hour or UTC day). */
  at: isoDateTime,
  requests: count,
  failed: count,
  costMicros: micros,
  /** Distinct people with a request in the bucket. */
  people: count,
  /** Aligned with `seriesKeys`. */
  requestsByKey: z.array(count),
  costByKey: z.array(micros),
}).strict();

export const globalOrganizationUsageSchema = z.object({
  /** null = requests made outside any organization. */
  orgId: id.nullable(),
  name: z.string(),
  requests: count,
  failed: count,
  costMicros: micros,
  /** People with a request in the window. */
  people: count,
  liveNow: count,
  lastRequestAt: isoDateTime.nullable(),
}).strict();

/**
 * GET /admin/global/dashboard?range=24h|7d|30d — every organization at once.
 * Hourly buckets for 24h, UTC days otherwise. Request numbers come from the
 * request log (metadata only); people from desktop activity.
 */
export const globalDashboardSchema = z.object({
  generatedAt: isoDateTime,
  range: globalDashboardRangeSchema,
  from: isoDateTime,
  to: isoDateTime,
  bucket: z.enum(["hour", "day"]),
  people: z.object({
    liveNow: count,
    activeToday: count,
    activeWeek: count,
  }).strict(),
  organizations: z.object({
    total: count,
    /** Organizations with at least one request in the window. */
    active: count,
    /** Organizations with someone live right now. */
    liveNow: count,
  }).strict(),
  requests: z.object({
    window: count,
    lastHour: count,
    failed: count,
    /** failed / window; 0 when there were no requests. */
    failureRate: share,
  }).strict(),
  spend: z.object({ windowMicros: micros, lastHourMicros: micros, monthMicros: micros }).strict(),
  /** Requests served by Alexandria cognitive compute (`provider = alexandria`). */
  cognitiveCompute: z.object({
    requests: count,
    costMicros: micros,
    requestShare: share,
    costShare: share,
  }).strict(),
  seriesKeys: z.array(globalSeriesKeySchema).max(GLOBAL_SERIES_ORGANIZATIONS + 2),
  series: z.array(globalSeriesPointSchema),
  /** Most requests first. */
  byOrganization: z.array(globalOrganizationUsageSchema),
  byModel: z.array(z.object({ model: z.string(), requests: count, failed: count, costMicros: micros }).strict()),
  byProvider: z.array(z.object({
    provider: z.string(),
    mode: z.enum(["confidential", "plaintext"]).nullable(),
    requests: count,
    failed: count,
    costMicros: micros,
  }).strict()),
  /** Failed requests by safe error code (`unknown` when none was recorded), most first. */
  failures: z.array(z.object({ errorCode: z.string(), requests: count, organizations: count }).strict()),
  topPeople: z.array(z.object({
    workosUserId: id,
    label: z.string(),
    email: z.string().nullable(),
    orgId: id.nullable(),
    orgName: z.string(),
    requests: count,
    failed: count,
    costMicros: micros,
  }).strict()),
  /** First request-log row anywhere; per-person numbers before it are not recorded. */
  attributionSince: isoDateTime.nullable(),
}).strict().superRefine((value, context) => {
  value.series.forEach((point, index) => {
    if (point.requestsByKey.length !== value.seriesKeys.length || point.costByKey.length !== value.seriesKeys.length) {
      context.addIssue({ code: "custom", message: "Series values must align with seriesKeys.", path: ["series", index] });
    }
  });
});
export type GlobalDashboard = z.infer<typeof globalDashboardSchema>;

export const globalLivePersonSchema = livePersonSchema.extend({
  orgId: id,
  orgName: z.string(),
}).strict();
export type GlobalLivePerson = z.infer<typeof globalLivePersonSchema>;

/** GET /admin/global/activity/live — people live in every organization, newest activity first. */
export const globalLiveActivitySchema = z.object({
  generatedAt: isoDateTime,
  people: z.array(globalLivePersonSchema),
  /** Organizations with someone live, most people first. */
  organizations: z.array(z.object({
    orgId: id,
    name: z.string(),
    people: count,
    requests: count,
    failed: count,
    costMicros: micros,
  }).strict()),
}).strict();
export type GlobalLiveActivity = z.infer<typeof globalLiveActivitySchema>;

export const globalAuditEntrySchema = z.object({
  id,
  source: z.enum(["policy", "commercial"]),
  orgId: id,
  orgName: z.string(),
  /** Policy or commercial audit action. */
  action: z.string(),
  actor: z.object({
    kind: z.enum(["operator", "agent", "system"]),
    id: z.string(),
    email: z.string().nullable(),
    client: z.string().nullable(),
  }).strict(),
  reason: z.string().nullable(),
  createdAt: isoDateTime,
}).strict();
export type GlobalAuditEntry = z.infer<typeof globalAuditEntrySchema>;

/** GET /admin/global/audit?limit= — operator changes across every organization, newest first. */
export const globalAuditListSchema = z.object({
  entries: z.array(globalAuditEntrySchema),
}).strict();
export type GlobalAuditList = z.infer<typeof globalAuditListSchema>;

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

export const invoiceSchema = z.object({
  id,
  number: z.string().nullable(),
  status: z.enum(["draft", "open", "paid", "uncollectible", "void"]),
  amountDueMicros: micros,
  amountPaidMicros: micros,
  currency: z.string(),
  description: z.string().nullable(),
  hostedInvoiceUrl: z.string().nullable(),
  pdfUrl: z.string().nullable(),
  createdAt: isoDateTime,
  dueAt: isoDateTime.nullable(),
  paidAt: isoDateTime.nullable(),
}).strict();
export type Invoice = z.infer<typeof invoiceSchema>;

/** GET /admin/organizations/:orgId/stripe/invoices */
export const invoiceListSchema = z.object({
  stripeEnabled: z.boolean(),
  customerId: z.string().nullable(),
  invoices: z.array(invoiceSchema),
}).strict();

/** POST /admin/organizations/:orgId/stripe/invoices — creates (and optionally sends) a one-off invoice. */
export const createInvoiceRequestSchema = z.object({
  /** Billing contact; used when the org has no Stripe customer yet. */
  email: z.email(),
  lines: z.array(z.object({
    description: z.string().trim().min(1).max(500),
    quantity: z.number().int().positive().max(1_000_000),
    unitAmountMicros: micros,
  }).strict()).min(1).max(50),
  daysUntilDue: z.number().int().positive().max(365),
  send: z.boolean(),
  reason,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
}).strict();

/** POST /admin/organizations/:orgId/stripe/payment-link body. `email` creates the Stripe customer when missing. */
export const paymentLinkRequestSchema = z.object({
  email: z.email().optional(),
  reason,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
}).strict();

/** POST /admin/organizations/:orgId/stripe/payment-link — hosted card setup for the usage plan. */
export const paymentLinkResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: isoDateTime.nullable(),
}).strict();

export const commercialAuditEntrySchema = z.object({
  id,
  action: z.enum(["billing_updated", "credits_adjusted", "seats_updated", "invoice_created", "payment_link_created"]),
  actor: z.object({ kind: z.enum(["operator", "agent"]), id, email: z.string().nullable(), client: z.string().nullable() }).strict(),
  reason: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  createdAt: isoDateTime,
}).strict();

/** GET /admin/organizations/:orgId/commercial/audit — newest first, at most 100. */
export const commercialAuditListSchema = z.object({
  entries: z.array(commercialAuditEntrySchema),
}).strict();

// Write responses: every mutation returns the resource's new state.
/** PUT …/billing and POST …/billing/credits */
export const billingUpdateResponseSchema = billingStateSchema;
/** PUT …/seats */
export const seatsUpdateResponseSchema = membersResponseSchema;
/** POST …/stripe/invoices (201) */
export const createInvoiceResponseSchema = invoiceSchema;
