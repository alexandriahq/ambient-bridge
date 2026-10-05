import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createBridgePlaintextClient } from "./effect.js";

describe("createBridgePlaintextClient", () => {
  it("uses the assigned endpoint without a legacy provider override", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const client = createBridgePlaintextClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      serverBaseUrl: "https://ambientserver-staging.up.railway.app/",
    });

    await Effect.runPromise(client.ready());
    const response = await Effect.runPromise(client.fetch("/v1/chat/completions", {
      body: JSON.stringify({ model: "deepseek-v4-flash" }),
      headers: { Authorization: "Bearer session" },
      method: "POST",
    }));

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://ambientserver-staging.up.railway.app/v1/chat/completions");
    expect(new Headers(init?.headers).get("X-Ambient-Inference-Mode")).toBeNull();
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer session");
  });
});
