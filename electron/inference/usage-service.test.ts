import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import type { UsageReservationRequest } from "@ambient/shared/usage";
import { AuthServerUsageError, type AuthServerClient } from "../auth/server-client.js";
import type { SignedInWorkOsSession } from "../workos/session.js";
import { BridgeInferenceServiceError, BridgeUsageRequestError } from "./errors.js";
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
