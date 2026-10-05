import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { BridgeSecureClientShape } from "./effect.js";
import { createCloudNodeSecureClient } from "./effect.js";

describe("Cloud Node secure inference route", () => {
  it("replaces the WorkOS bearer and translates request metadata for Node policy", async () => {
    const fetch = vi.fn(() => Effect.succeed(new Response(null, { status: 200 })));
    const client: BridgeSecureClientShape = {
      ready: () => Effect.void,
      fetch,
    };
    const routed = createCloudNodeSecureClient({
      client,
      accessToken: "cloud-node-identity",
      mode: "confidential",
    });
    await Effect.runPromise(routed.fetch("/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer sealed-workos-session",
        "X-Ambient-Feature": "inference.responses",
        "X-Ambient-Model-Id": "glm-5-2",
        "X-Ambient-Request-Id": "req_test_12345678",
      },
    }));
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer cloud-node-identity");
    expect(headers.get("x-alexandria-feature")).toBe("bridge");
    expect(headers.get("x-alexandria-inference-mode")).toBe("confidential");
    expect(headers.get("x-alexandria-model")).toBe("glm-5-2");
    expect(headers.get("x-alexandria-request-id")).toBe("req_test_12345678");
    expect(JSON.stringify([...headers])).not.toContain("sealed-workos-session");
  });

  it("marks an explicitly assigned plaintext route without changing destination custody", async () => {
    const fetch = vi.fn(() => Effect.succeed(new Response(null, { status: 200 })));
    const routed = createCloudNodeSecureClient({
      client: { ready: () => Effect.void, fetch },
      accessToken: "cloud-node-identity",
      mode: "plaintext",
    });
    await Effect.runPromise(routed.fetch("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sealed-workos-session" },
    }));
    const headers = new Headers((fetch.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get("authorization")).toBe("Bearer cloud-node-identity");
    expect(headers.get("x-alexandria-inference-mode")).toBe("plaintext");
    expect(JSON.stringify([...headers])).not.toContain("sealed-workos-session");
  });

  it("marks the dedicated daily-report Responses route without trusting caller headers", async () => {
    const fetch = vi.fn(() => Effect.succeed(new Response(null, { status: 200 })));
    const routed = createCloudNodeSecureClient({
      client: { ready: () => Effect.void, fetch },
      accessToken: "cloud-node-identity",
      mode: "confidential",
      feature: "daily_report",
    });
    await Effect.runPromise(routed.fetch("/v1/responses", {
      method: "POST",
      headers: { "x-alexandria-feature": "caller-controlled" },
    }));
    const headers = new Headers((fetch.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get("x-alexandria-feature")).toBe("daily_report");
  });
});
