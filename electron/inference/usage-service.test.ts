import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import type { UsageReservationRequest } from "@ambient/shared/usage";
import { AuthServerUsageError, type AuthServerClient } from "../auth/server-client.js";
import type { SignedInWorkOsSession } from "../workos/session.js";
import {
  BridgeGloballyDisabledError,
  BridgeInferenceServiceError,
  BridgeInsufficientCreditError,
  BridgeUsageRequestError,
  globallyDisabledRefusalText,
} from "./errors.js";
import {
  BridgeUsageAccountingDisabledError,
  createBridgeUsageService,
} from "./usage-service.js";

describe("Bridge usage service reservation failures", () => {
  test("normalizes transient usage-accounting outages into the availability circuit domain", async () => {
    const service = createBridgeUsageService(clientRejecting(502));
    const result = await Effect.runPromise(Effect.either(service.reserve(reservationInput())));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(BridgeInferenceServiceError);
      expect(result.left).toMatchObject({
        code: "UPSTREAM_BILLING_UNAVAILABLE",
        httpStatus: 502,
      });
    }
  });

  test("preserves the explicit accounting-disabled signal for unmetered compatibility", async () => {
    const service = createBridgeUsageService(clientRejecting(503));
    const result = await Effect.runPromise(Effect.either(service.reserve(reservationInput())));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(BridgeUsageAccountingDisabledError);
    }
  });

  test.each(["INSUFFICIENT_CREDIT", "SPENDING_LIMIT_REACHED", "BILLING_PAST_DUE"] as const)(
    "treats %s as account exhaustion (ADR-0243)",
    async (code) => {
      const service = createBridgeUsageService({
        reserveUsage: async () => { throw new AuthServerUsageError(402, code, "Refused"); },
      } as unknown as AuthServerClient);
      const result = await Effect.runPromise(Effect.either(service.reserve(reservationInput())));
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left).toBeInstanceOf(BridgeInsufficientCreditError);
    },
  );

  test("maps a globally disabled reservation refusal to policy_denied with the precise text (ADR-0296)", async () => {
    const service = createBridgeUsageService({
      reserveUsage: async () => {
        throw new AuthServerUsageError(403, "BILLING_FORBIDDEN", "globally_disabled: Claude is temporarily unavailable.");
      },
    } as unknown as AuthServerClient);
    const result = await Effect.runPromise(Effect.either(service.reserve(reservationInput())));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(BridgeGloballyDisabledError);
      expect(result.left).toMatchObject({ code: "policy_denied", message: "globally_disabled: Claude is temporarily unavailable." });
      expect(globallyDisabledRefusalText(result.left)).toBe("Claude is temporarily unavailable.");
    }
  });

  test("keeps other BILLING_FORBIDDEN refusals generic", async () => {
    const service = createBridgeUsageService({
      reserveUsage: async () => { throw new AuthServerUsageError(403, "BILLING_FORBIDDEN", "Forbidden"); },
    } as unknown as AuthServerClient);
    const result = await Effect.runPromise(Effect.either(service.reserve(reservationInput())));
    expect(result._tag === "Left" && result.left).toBeInstanceOf(BridgeUsageRequestError);
  });

  test("reads a Node grant refusal by code and prefix only", () => {
    expect(globallyDisabledRefusalText({ code: "policy_denied", message: "globally_disabled: The model x is temporarily unavailable." }))
      .toBe("The model x is temporarily unavailable.");
    expect(globallyDisabledRefusalText({ code: "policy_denied", message: "seat_limit_reached: full" })).toBeNull();
    expect(globallyDisabledRefusalText({ code: "credit_exhausted", message: "globally_disabled: x" })).toBeNull();
    expect(globallyDisabledRefusalText(null)).toBeNull();
  });

  test.each([400, 401])("keeps permanent usage status %i outside transient recovery", async (status) => {
    const service = createBridgeUsageService(clientRejecting(status));
    const result = await Effect.runPromise(Effect.either(service.reserve(reservationInput())));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(BridgeUsageRequestError);
  });
});

function clientRejecting(status: number): AuthServerClient {
  return {
    reserveUsage: async (_token: string, _request: UsageReservationRequest) => {
      throw new AuthServerUsageError(status, "USAGE_UNAVAILABLE", "Usage unavailable");
    },
  } as AuthServerClient;
}

function reservationInput(): Parameters<ReturnType<typeof createBridgeUsageService>["reserve"]>[0] {
  return {
    modelId: "model_test",
    requestId: "req_usage",
    route: "/v1/chat/completions",
    session: {
      kind: "signed_in",
      userId: "user_test",
      organizationId: "org_test",
      sessionToken: "sealed_session_test",
    } as SignedInWorkOsSession,
  };
}
