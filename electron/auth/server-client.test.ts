import { describe, expect, test, vi } from "vitest";
import { AuthServerClient, AuthServerRequestError } from "./server-client.js";

describe("AuthServerClient.inferencePlan", () => {
  const client = (response: Response) => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => response);
    return { fetchImpl, client: new AuthServerClient({ baseUrl: "https://cloud.example.test", fetchImpl: fetchImpl as unknown as typeof fetch }) };
  };

  test("sends the identity and If-None-Match, and returns the body with its ETag", async () => {
    const { fetchImpl, client: api } = client(new Response(JSON.stringify({ schemaVersion: 1 }), { status: 200, headers: { etag: "\"p2\"" } }));
    await expect(api.inferencePlan("session_a", "\"p1\"")).resolves.toEqual({ kind: "ok", etag: "\"p2\"", body: { schemaVersion: 1 } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://cloud.example.test/v1/inference/plan");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer session_a", "If-None-Match": "\"p1\"" });
  });

  test("maps 304 and a Cloud without the plan (404)", async () => {
    await expect(client(new Response(null, { status: 304 })).client.inferencePlan("s", "\"p1\"")).resolves.toEqual({ kind: "not_modified" });
    await expect(client(new Response("{}", { status: 404 })).client.inferencePlan("s", null)).resolves.toEqual({ kind: "not_found" });
  });

  test("throws on other failures", async () => {
    await expect(client(new Response(JSON.stringify({ error: "nope" }), { status: 401 })).client.inferencePlan("s", null))
      .rejects.toBeInstanceOf(AuthServerRequestError);
  });
});
