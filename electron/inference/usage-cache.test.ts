import { describe, expect, test, vi } from "vitest";
import type { UsageSummary } from "@ambient/shared/usage";
import { AuthServerTimeoutError, AuthServerUsageError } from "../auth/server-client.js";
import type { SignedInWorkOsSession } from "../workos/session.js";
import { BridgeUsageCache } from "./usage-cache.js";

describe("Bridge usage cache", () => {
  test("returns fresh data, marks failed refreshes stale, and never turns unknown into zero", async () => {
    let nowMs = 1_000;
    const cache = new BridgeUsageCache(100, () => nowMs);
    const load = vi.fn(async () => summary("org_a", "100"));
    await expect(cache.read({ session: session("org_a"), load })).resolves.toMatchObject({ state: "ready" });
    await expect(cache.read({ session: session("org_a"), load })).resolves.toMatchObject({ state: "ready" });
    expect(load).toHaveBeenCalledTimes(1);

    nowMs = 1_101;
    load.mockRejectedValueOnce(new AuthServerTimeoutError(10));
    await expect(cache.read({ session: session("org_a"), force: true, load })).resolves.toMatchObject({
      state: "stale",
      summary: { remainingMicros: "100" },
    });

    const empty = new BridgeUsageCache(100, () => nowMs);
    await expect(empty.read({
      session: session("org_a"),
      load: async () => { throw new AuthServerTimeoutError(10); },
    })).resolves.toEqual({ state: "unavailable", reason: "offline" });
  });

  test("clears data across organization and sign-out boundaries", async () => {
    const cache = new BridgeUsageCache();
    await cache.read({ session: session("org_a"), load: async () => summary("org_a", "25") });
    await expect(cache.read({
      session: session("org_b"),
      load: async () => { throw new Error("server down"); },
    })).resolves.toEqual({ state: "unavailable", reason: "server_error" });
    await expect(cache.read({ session: null, load: async () => summary("org_a", "25") }))
      .resolves.toEqual({ state: "unavailable", reason: "signed_out" });
  });

  test("rejects a mismatched tenant summary rather than leaking it", async () => {
    const cache = new BridgeUsageCache();
    await expect(cache.read({ session: session("org_a"), load: async () => summary("org_b", "999") }))
      .resolves.toEqual({ state: "unavailable", reason: "server_error" });
  });

  test("reports the existing disabled-accounting response as not enabled", async () => {
    const cache = new BridgeUsageCache();
    await expect(cache.read({
      session: session("org_a"),
      load: async () => {
        throw new AuthServerUsageError(
          503,
          "USAGE_UNAVAILABLE",
          "Inference usage accounting is not enabled.",
        );
      },
    })).resolves.toEqual({ state: "unavailable", reason: "not_enabled" });
  });
});

function session(organizationId: string): SignedInWorkOsSession {
  return {
    kind: "signed_in",
    email: "user@example.test",
    expiresAt: 2_000_000_000,
    organizationId,
    sessionToken: "session_test",
    user: { id: "user_test", email: "user@example.test", name: null },
  };
}

function summary(id: string, remainingMicros: string): UsageSummary {
  return {
    schemaVersion: 1,
    owner: { kind: "organization", id },
    currency: "USD",
    period: { kind: "lifetime" },
    mode: "metered",
    grantedMicros: "100",
    usedMicros: String(100n - BigInt(remainingMicros)),
    reservedMicros: "0",
    remainingMicros,
    updatedAt: "2026-07-20T12:00:00.000Z",
  };
}
