import { z } from "zod";

// Subscription plans for people without an organization (ADR-0324). A plan is
// data an operator creates in the Alexandria console: a name, its price and
// Stripe price, the inference included per billing period, and what happens
// when that runs out. Its product settings are a policy layer under Public
// customers (ADR-0323), edited like any organization's policy. Nothing about a
// particular plan is written in code.
//
// Money is integer USD micros as a decimal string (1 USD = 1,000,000).

const micros = z.string().regex(/^(0|[1-9][0-9]*)$/);
const isoDateTime = z.iso.datetime({ offset: true });
const reason = z.string().trim().min(3).max(1000);

/** Plan ids share the policy-target namespace: never a WorkOS id (`org_…`) or a layer (`layer_…`). */
export const PLAN_ID_PATTERN = /^plan_[a-z0-9][a-z0-9_-]{0,62}$/;
export const planIdSchema = z.string().regex(PLAN_ID_PATTERN, "Plan ids look like plan_plus.");

export function isPlanId(id: string): boolean {
  return PLAN_ID_PATTERN.test(id);
}

export const PLAN_STATUSES = ["active", "archived"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_INTERVALS = ["month", "year"] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];

/**
 * When the included inference for the period is used up:
 * - `block`: requests stop until the next period or an upgrade.
 * - `metered_overage`: the rest is billed to the card as usage (the person
 *   turns pay-as-you-go on in Billing; without it this behaves like `block`).
 */
export const PLAN_EXHAUSTION = ["block", "metered_overage"] as const;
export type PlanExhaustion = (typeof PLAN_EXHAUSTION)[number];

export const planTermsSchema = z.object({
  /** What the picker shows. The Stripe price decides what is charged; keep them equal. */
  priceMicros: micros,
  interval: z.enum(PLAN_INTERVALS),
  /** Recurring Stripe price Checkout uses. null = not purchasable yet. */
  stripePriceId: z.string().regex(/^price_[A-Za-z0-9]{1,200}$/, "A Stripe price id looks like price_…").nullable(),
  /** Inference cost included per billing period. */
  includedMicros: micros,
  whenExhausted: z.enum(PLAN_EXHAUSTION),
  /** Offered in the onboarding and Billing plan picker. Hidden plans can still be assigned. */
  selfServe: z.boolean(),
}).strict();
export type PlanTerms = z.infer<typeof planTermsSchema>;

export const planSchema = z.object({
  id: planIdSchema,
  name: z.string().trim().min(1).max(60),
  /** One line under the name in the picker. */
  tagline: z.string().trim().max(200).default(""),
  /** Short bullet points in the picker. */
  highlights: z.array(z.string().trim().min(1).max(120)).max(6).default([]),
  /** Picker order, lowest first. */
  position: z.number().int().min(0).max(1000),
  status: z.enum(PLAN_STATUSES),
  terms: planTermsSchema,
  updatedAt: isoDateTime,
}).strict();
export type Plan = z.infer<typeof planSchema>;

/** Settings that apply to every plan. */
export const planSettingsSchema = z.object({
  /**
   * People without an organization need an active plan to use Alexandria
   * inference. Off = today's behaviour (pay as you go). The rollout switch.
   */
  requiredForPersonal: z.boolean(),
}).strict();
export type PlanSettings = z.infer<typeof planSettingsSchema>;

export const DEFAULT_PLAN_SETTINGS: PlanSettings = { requiredForPersonal: false };

// ---------------------------------------------------------------------------
// Operator API (`/admin/plans*`)
// ---------------------------------------------------------------------------

export const adminPlanListSchema = z.object({
  plans: z.array(planSchema),
  settings: planSettingsSchema,
  /** Subscriptions that grant a plan right now, per plan id. */
  subscribers: z.record(z.string(), z.number().int().min(0)),
}).strict();
export type AdminPlanList = z.infer<typeof adminPlanListSchema>;

/** PUT /admin/plans/:planId — create or replace. */
export const savePlanRequestSchema = z.object({
  plan: planSchema.omit({ id: true, updatedAt: true }),
  reason,
}).strict();
export type SavePlanRequest = z.infer<typeof savePlanRequestSchema>;

/** PUT /admin/plans/settings */
export const savePlanSettingsRequestSchema = z.object({
  settings: planSettingsSchema,
  reason,
}).strict();

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/** Stripe subscription statuses, as stored. */
export const SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Statuses that grant the plan. `past_due` keeps it while Stripe retries the payment. */
export function subscriptionGrantsPlan(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing" || status === "past_due";
}

export const planSubscriptionSchema = z.object({
  workosUserId: z.string().min(1).max(200),
  planId: planIdSchema,
  stripeCustomerId: z.string().min(1).max(200),
  stripeSubscriptionId: z.string().min(1).max(200),
  stripePriceId: z.string().min(1).max(200),
  status: z.enum(SUBSCRIPTION_STATUSES),
  currentPeriodStart: isoDateTime,
  currentPeriodEnd: isoDateTime,
  cancelAtPeriodEnd: z.boolean(),
  /** The period whose included usage was applied; a paid renewal applies the next one exactly once. */
  allowancePeriodStart: isoDateTime.nullable(),
  /**
   * The plan's included usage for that period (upgrades add to it). It is
   * spent before purchased credit, and only its unused part expires at the
   * next period; purchased credit is never taken.
   */
  allowanceGrantedMicros: micros,
  /** The account's lifetime spend (used + held) when the period's allowance was applied. */
  allowanceUsedBaselineMicros: micros,
  updatedAt: isoDateTime,
}).strict();
export type PlanSubscription = z.infer<typeof planSubscriptionSchema>;

// ---------------------------------------------------------------------------
// Account API (`/v1/plans*`, signed-in Bridge session)
// ---------------------------------------------------------------------------

export const publicPlanSchema = z.object({
  id: planIdSchema,
  name: z.string(),
  tagline: z.string(),
  highlights: z.array(z.string()),
  priceMicros: micros,
  interval: z.enum(PLAN_INTERVALS),
  includedMicros: micros,
  /** Checkout is possible (a Stripe price is set and Cloud can reach Stripe). */
  purchasable: z.boolean(),
  /**
   * Inference modes the plan offers, from its published settings (ADR-0324).
   * Absent from older Clouds; empty = every mode.
   */
  modes: z.array(z.enum(["confidential", "zero-retention"])).optional(),
  /** Live and deep reasoning run on the person's own ChatGPT or Claude. */
  reasoningOnOwnSubscription: z.boolean().optional(),
});
export type PublicPlan = z.infer<typeof publicPlanSchema>;

export const accountPlanSchema = z.object({
  planId: planIdSchema,
  name: z.string(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  /** The plan applies now. */
  active: z.boolean(),
  currentPeriodEnd: isoDateTime,
  cancelAtPeriodEnd: z.boolean(),
  includedMicros: micros,
  whenExhausted: z.enum(PLAN_EXHAUSTION),
});
export type AccountPlan = z.infer<typeof accountPlanSchema>;

/** GET /v1/plans. Optional fields stay optional: Bridge parses this leniently. */
export const accountPlansResponseSchema = z.object({
  /** false for organization members: their organization's terms apply and nothing here is shown. */
  eligible: z.boolean(),
  /** A plan is needed before Alexandria inference works. */
  required: z.boolean(),
  plans: z.array(publicPlanSchema),
  subscription: accountPlanSchema.nullable(),
  /** The Stripe customer portal can be opened (change plan, cancel, card, invoices). */
  manageable: z.boolean(),
});
export type AccountPlansResponse = z.infer<typeof accountPlansResponseSchema>;

/** POST /v1/plans/checkout */
export const planCheckoutRequestSchema = z.object({ planId: planIdSchema }).strict();
export const planCheckoutResponseSchema = z.object({ checkoutUrl: z.url() });
export type PlanCheckoutResponse = z.infer<typeof planCheckoutResponseSchema>;

/** POST /v1/plans/portal */
export const planPortalResponseSchema = z.object({ portalUrl: z.url() });
export type PlanPortalResponse = z.infer<typeof planPortalResponseSchema>;

/**
 * Message prefixes on refused inference (HTTP 402 `credit_exhausted`), read by
 * Bridge like `seat_limit_reached:`. Older desktops show the generic message.
 */
export const PLAN_REFUSAL_PREFIXES = {
  planRequired: "plan_required",
  allowanceExhausted: "allowance_exhausted",
} as const;
