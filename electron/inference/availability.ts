import type { UsageSummary } from "@ambient/shared/usage";
import type { SignedInWorkOsSession } from "../workos/session.js";
import {
  BridgeInferenceServiceError,
  BridgeInsufficientCreditError,
} from "./errors.js";

export type InferenceAvailabilitySnapshot =
  | { readonly state: "ready" }
  | { readonly state: "account_exhausted"; readonly ownerKey: string; readonly updatedAt: string | null }
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
    if (summary.mode === "unlimited" || BigInt(summary.remainingMicros ?? "0") > 0n) {
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
    if (ownerKey) this.#accountErrors.delete(ownerKey);
    else this.#accountErrors.clear();
  }

  snapshot(ownerKey?: string): InferenceAvailabilitySnapshot {
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

function usageOwnerKey(owner: UsageSummary["owner"]): string {
  return `${owner.kind}:${owner.id}`;
}
