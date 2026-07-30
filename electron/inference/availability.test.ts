import { describe, expect, test } from "vitest";
import type { UsageSummary } from "@ambient/shared/usage";
import { InferenceAvailabilityCircuit } from "./availability.js";
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
