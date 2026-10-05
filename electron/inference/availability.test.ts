import { describe, expect, test } from "vitest";
import type { UsageSummary } from "@ambient/shared/usage";
import { InferenceAvailabilityCircuit, inferenceAccessBlockReason } from "./availability.js";
import { BridgeInferenceServiceError, BridgeInsufficientCreditError } from "./errors.js";

describe("inference availability circuits", () => {
  test("blocks only the exhausted account and recovers after a positive summary", () => {
    const circuit = new InferenceAvailabilityCircuit();
    circuit.observeSummary(summary("org_a", "0"));
    expect(() => circuit.beforeRequest("organization:org_a")).toThrow(BridgeInsufficientCreditError);
    expect(() => circuit.beforeRequest("organization:org_b")).not.toThrow();

    circuit.observeSummary(summary("org_a", "100"));
    expect(() => circuit.beforeRequest("organization:org_a")).not.toThrow();
  });

  test("card-backed usage billing keeps an exhausted account usable; limits and failed invoices block it (ADR-0243)", () => {
    const circuit = new InferenceAvailabilityCircuit();
    const metered = { ...summary("org_a", "0"), billing: { mode: "usage" as const, meteredActive: true, blockedReason: null } };
    circuit.observeSummary(metered);
    expect(() => circuit.beforeRequest("organization:org_a")).not.toThrow();

    circuit.observeSummary({ ...summary("org_a", "100"), billing: { mode: "usage", meteredActive: true, blockedReason: "spending_limit" } });
    expect(circuit.snapshot("organization:org_a").state).toBe("account_exhausted");
    circuit.observeSummary({ ...summary("org_a", "100"), billing: { mode: "usage", meteredActive: false, blockedReason: "past_due" } });
    expect(() => circuit.beforeRequest("organization:org_a")).toThrow(BridgeInsufficientCreditError);

    circuit.observeSummary(metered);
    expect(circuit.snapshot("organization:org_a")).toEqual({ state: "ready" });
  });

  test("reads seat, member and plan refusals from the message prefix (ADR-0324)", () => {
    expect(inferenceAccessBlockReason("policy_denied", "seat_limit_reached: no free seat")).toBe("seat_limit_reached");
    expect(inferenceAccessBlockReason("credit_exhausted", "member_limit_reached: cap")).toBe("member_limit_reached");
    expect(inferenceAccessBlockReason("credit_exhausted", "plan_required: choose a plan")).toBe("plan_required");
    expect(inferenceAccessBlockReason("credit_exhausted", "allowance_exhausted: used up")).toBe("allowance_exhausted");
    expect(inferenceAccessBlockReason("policy_denied", "plan_required: choose a plan")).toBeNull();
    expect(inferenceAccessBlockReason("credit_exhausted", "No credit left.")).toBeNull();
  });

  test("a plan block expires on its own and clears only for its reason", () => {
    const circuit = new InferenceAvailabilityCircuit();
    circuit.accessBlocked("user:u1", "plan_required", 1_000);
    expect(circuit.snapshot("user:u1", 1_000)).toEqual({ state: "plan_required", ownerKey: "user:u1", retryAtMs: 61_000 });
    circuit.accessRestored("user:u1", "allowance_exhausted");
    expect(circuit.snapshot("user:u1", 1_000).state).toBe("plan_required");
    circuit.accessRestored("user:u1", ["plan_required", "allowance_exhausted"]);
    expect(circuit.snapshot("user:u1", 1_000)).toEqual({ state: "ready" });

    circuit.accessBlocked("user:u1", "allowance_exhausted", 1_000);
    expect(circuit.snapshot("user:u1", 600_999).state).toBe("allowance_exhausted");
    expect(circuit.snapshot("user:u1", 601_000)).toEqual({ state: "ready" });
  });

  test("holds a provider outage separately and permits one bounded half-open probe", () => {
    const circuit = new InferenceAvailabilityCircuit();
    circuit.serviceUnavailable(new BridgeInferenceServiceError("UPSTREAM_BILLING_UNAVAILABLE", 503, 60), 1_000);
    expect(circuit.snapshot("organization:org_a")).toMatchObject({
      state: "service_degraded",
      code: "UPSTREAM_BILLING_UNAVAILABLE",
      retryAtMs: 61_000,
    });
    expect(() => circuit.beforeRequest("organization:org_a", 60_999)).toThrow(BridgeInferenceServiceError);
    expect(() => circuit.beforeRequest("organization:org_a", 61_000)).not.toThrow();
    expect(() => circuit.beforeRequest("organization:org_b", 61_001)).toThrow(BridgeInferenceServiceError);
    circuit.serviceRecovered();
    expect(circuit.snapshot()).toEqual({ state: "ready" });
  });
});

function summary(id: string, remainingMicros: string): UsageSummary {
  return {
    schemaVersion: 1,
    owner: { kind: "organization", id },
    currency: "USD",
    period: { kind: "lifetime" },
    mode: "metered",
    grantedMicros: "100",
    usedMicros: remainingMicros === "0" ? "100" : "0",
    reservedMicros: "0",
    remainingMicros,
    updatedAt: "2026-07-20T12:00:00.000Z",
  };
}

describe("member access blocks", () => {
  test("reports seat and member caps per owner, expires them, and clears on restore", () => {
    const circuit = new InferenceAvailabilityCircuit();
    circuit.accessBlocked("organization:org_a", "seat_limit_reached", 1_000);
    expect(circuit.snapshot("organization:org_a", 2_000)).toEqual({ state: "seat_limit_reached", ownerKey: "organization:org_a", retryAtMs: 121_000 });
    expect(circuit.snapshot("organization:org_b", 2_000).state).toBe("ready");
    expect(() => circuit.beforeRequest("organization:org_a", 2_000)).not.toThrow();
    expect(circuit.snapshot("organization:org_a", 121_001).state).toBe("ready");
    circuit.accessBlocked("organization:org_a", "member_limit_reached", 1_000);
    circuit.accessRestored("organization:org_a", "seat_limit_reached");
    expect(circuit.snapshot("organization:org_a", 2_000).state).toBe("member_limit_reached");
    circuit.accessRestored("organization:org_a");
    expect(circuit.snapshot("organization:org_a", 2_000).state).toBe("ready");
  });
});
