import { PLAN_REFUSAL_PREFIXES } from "@alexandria/cloud-contract/plans";
import type { UsageSummary } from "@ambient/shared/usage";
import type { SignedInWorkOsSession } from "../workos/session.js";
import {
  BridgeInferenceServiceError,
  BridgeInsufficientCreditError,
} from "./errors.js";

/**
 * Cloud refused this account: no free seat or the member's own spending cap
 * (org accounts), or no plan / the plan's included usage used up (personal
 * accounts on subscription plans, ADR-0324).
 */
export type InferenceAccessBlockReason =
  | "seat_limit_reached"
  | "member_limit_reached"
  | "plan_required"
  | "allowance_exhausted";

/** How long a block shows before the next request re-checks it. */
const ACCESS_BLOCK_MS: Readonly<Record<InferenceAccessBlockReason, number>> = {
  seat_limit_reached: 120_000,
  member_limit_reached: 600_000,
  // Short: a checkout finished in the browser should show quickly.
  plan_required: 60_000,
  allowance_exhausted: 600_000,
};

/**
 * Cloud keeps the shipped transport codes and puts the reason in the message
 * prefix: a seat refusal is `policy_denied` starting `seat_limit_reached`; a
 * member cap, a missing plan and a used-up plan allowance are
 * `credit_exhausted` starting `member_limit_reached`, `plan_required` and
 * `allowance_exhausted`.
 */
export function inferenceAccessBlockReason(code: string, message: string): InferenceAccessBlockReason | null {
  if (code === "policy_denied" && message.startsWith("seat_limit_reached")) return "seat_limit_reached";
  if (code !== "credit_exhausted") return null;
  if (message.startsWith("member_limit_reached")) return "member_limit_reached";
  if (message.startsWith(`${PLAN_REFUSAL_PREFIXES.planRequired}:`)) return "plan_required";
  if (message.startsWith(`${PLAN_REFUSAL_PREFIXES.allowanceExhausted}:`)) return "allowance_exhausted";
  return null;
}

export type InferenceAvailabilitySnapshot =
  | { readonly state: "ready" }
  | { readonly state: "account_exhausted"; readonly ownerKey: string; readonly updatedAt: string | null }
  | { readonly state: InferenceAccessBlockReason; readonly ownerKey: string; readonly retryAtMs: number }
  | {
      readonly state: "service_degraded";
      readonly code: "UPSTREAM_BILLING_UNAVAILABLE" | "UPSTREAM_ENVELOPE_UNAVAILABLE";
      readonly retryAtMs: number;
    };

export class InferenceAvailabilityCircuit {
  readonly #accountErrors = new Map<string, BridgeInsufficientCreditError>();
  #serviceError: BridgeInferenceServiceError | null = null;
  #serviceRetryAtMs = 0;
  #serviceProbeInFlight = false;
  readonly #accessBlocks = new Map<string, { readonly reason: InferenceAccessBlockReason; readonly untilMs: number }>();

  /**
   * Status only: requests still go out (Cloud stays authoritative), and the
   * block expires so a seat freed or a new period is noticed without restart.
   */
  accessBlocked(ownerKey: string, reason: InferenceAccessBlockReason, nowMs = Date.now()): void {
    this.#accessBlocks.set(ownerKey, { reason, untilMs: nowMs + ACCESS_BLOCK_MS[reason] });
  }

  accessRestored(ownerKey: string, reason?: InferenceAccessBlockReason | readonly InferenceAccessBlockReason[]): void {
    const current = this.#accessBlocks.get(ownerKey)?.reason;
    if (!current) return;
    const reasons: readonly InferenceAccessBlockReason[] | null = reason === undefined ? null : typeof reason === "string" ? [reason] : reason;
    if (!reasons || reasons.includes(current)) this.#accessBlocks.delete(ownerKey);
  }

  beforeRequest(ownerKey: string, nowMs = Date.now()): void {
    const accountError = this.#accountErrors.get(ownerKey);
    if (accountError) throw accountError;
    if (!this.#serviceError) return;
    if (nowMs < this.#serviceRetryAtMs || this.#serviceProbeInFlight) throw this.#serviceError;
    // Permit one half-open probe when the server's bounded retry window elapses.
    this.#serviceProbeInFlight = true;
  }

  accountExhausted(ownerKey: string, error: BridgeInsufficientCreditError): void {
    this.#accountErrors.set(ownerKey, error);
  }

  observeSummary(summary: UsageSummary): void {
    const ownerKey = usageOwnerKey(summary.owner);
    if (summaryCanSpend(summary)) {
      this.#accountErrors.delete(ownerKey);
      return;
    }
    this.#accountErrors.set(ownerKey, new BridgeInsufficientCreditError(summary));
  }

  serviceUnavailable(error: BridgeInferenceServiceError, nowMs = Date.now()): void {
    this.#serviceError = error;
    this.#serviceRetryAtMs = nowMs + error.retryAfterSeconds * 1_000;
    this.#serviceProbeInFlight = false;
  }

  serviceProbeFailed(nowMs = Date.now()): void {
    if (!this.#serviceError) return;
    this.#serviceRetryAtMs = nowMs + this.#serviceError.retryAfterSeconds * 1_000;
    this.#serviceProbeInFlight = false;
  }

  serviceRecovered(): void {
    this.#serviceError = null;
    this.#serviceRetryAtMs = 0;
    this.#serviceProbeInFlight = false;
  }

  clearAccount(ownerKey?: string): void {
    if (ownerKey) {
      this.#accountErrors.delete(ownerKey);
      this.#accessBlocks.delete(ownerKey);
    } else {
      this.#accountErrors.clear();
      this.#accessBlocks.clear();
    }
  }

  snapshot(ownerKey?: string, nowMs = Date.now()): InferenceAvailabilitySnapshot {
    const block = ownerKey ? this.#accessBlocks.get(ownerKey) : undefined;
    if (ownerKey && block) {
      if (block.untilMs > nowMs) return { state: block.reason, ownerKey, retryAtMs: block.untilMs };
      this.#accessBlocks.delete(ownerKey);
    }
    if (ownerKey && this.#accountErrors.has(ownerKey)) {
      const summary = this.#accountErrors.get(ownerKey)?.summary;
      return { state: "account_exhausted", ownerKey, updatedAt: summary?.updatedAt ?? null };
    }
    if (this.#serviceError) {
      return { state: "service_degraded", code: this.#serviceError.code, retryAtMs: this.#serviceRetryAtMs };
    }
    return { state: "ready" };
  }
}

export function sessionUsageOwnerKey(session: SignedInWorkOsSession): string {
  return session.organizationId
    ? `organization:${session.organizationId}`
    : `user:${session.user.id}`;
}

/**
 * Whether the server would accept a new hold (ADR-0243): unlimited, prepaid
 * credit left, or card-backed usage billing — unless a spending limit or a
 * failed invoice blocks it.
 */
export function summaryCanSpend(summary: UsageSummary): boolean {
  if (summary.mode === "unlimited") return true;
  if (summary.billing?.blockedReason === "spending_limit" || summary.billing?.blockedReason === "past_due") return false;
  if (summary.billing?.meteredActive) return true;
  return BigInt(summary.remainingMicros ?? "0") > 0n;
}

function usageOwnerKey(owner: UsageSummary["owner"]): string {
  return `${owner.kind}:${owner.id}`;
}
