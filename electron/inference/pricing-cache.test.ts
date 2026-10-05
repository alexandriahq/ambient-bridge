import { describe, expect, test } from "vitest";
import type { UsagePricingCatalog } from "@ambient/shared/usage";
import type { SignedInWorkOsSession } from "../workos/session.js";
import { BridgePricingCache } from "./pricing-cache.js";

const catalog = (version: string): UsagePricingCatalog => ({
  schemaVersion: 1,
  version,
  prices: [{
    route: "/v1/chat/completions",
    modelId: "glm-5-2",
    billing: "tokens",
    inputMicrosPerMillion: "1500000",
    outputMicrosPerMillion: "5250000",
    requestMicros: null,
    reservationMicros: "5250000",
  }],
});

describe("BridgePricingCache", () => {
  test("caches by owner and refreshes after TTL or force", async () => {
    let nowMs = 1_000;
    let loads = 0;
    const cache = new BridgePricingCache(100, () => nowMs);
    const session = signedIn("org_a");

    const first = await cache.read({
      session,
      load: async () => {
        loads += 1;
        return catalog("v1");
      },
    });
    expect(first.version).toBe("v1");
    expect(loads).toBe(1);

    await cache.read({
      session,
      load: async () => {
        loads += 1;
        return catalog("v2");
      },
    });
    expect(loads).toBe(1);

    nowMs = 1_200;
    const forced = await cache.read({
      session,
      force: true,
      load: async () => {
        loads += 1;
        return catalog("v2");
      },
    });
    expect(forced.version).toBe("v2");
    expect(loads).toBe(2);
  });

  test("rejects signed-out reads and clears on owner change", async () => {
    const cache = new BridgePricingCache();
    await expect(cache.read({
      session: null,
      load: async () => catalog("v1"),
    })).rejects.toThrow(/Sign in/);

    await cache.read({
      session: signedIn("org_a"),
      load: async () => catalog("org-a"),
    });
    const next = await cache.read({
      session: signedIn("org_b"),
      load: async () => catalog("org-b"),
    });
    expect(next.version).toBe("org-b");
  });
});

function signedIn(organizationId: string): SignedInWorkOsSession {
  return {
    kind: "signed_in",
    sessionToken: `session_${organizationId}`,
    expiresAt: Date.now() + 60_000,
    organizationId,
    email: "user@example.test",
    user: { id: "user_test", email: "user@example.test", name: "User" },
    featureFlags: [],
  };
}
