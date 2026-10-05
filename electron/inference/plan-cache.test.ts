import { describe, expect, test, vi } from "vitest";
import type { InferencePlan } from "@alexandria/cloud-contract/inference-catalog";
import { AuthServerTimeoutError, type InferencePlanFetchResult } from "../auth/server-client.js";
import type { SignedInWorkOsSession } from "../workos/session.js";
import { BridgeInferencePlanCache, inferencePlanOwnerKey } from "./plan-cache.js";

const session: SignedInWorkOsSession = {
  kind: "signed_in",
  sessionToken: "session_a",
  expiresAt: 2_000_000_000,
  user: { id: "user_a", email: "a@example.test", name: "A" },
  email: "a@example.test",
  organizationId: "org_valen",
};

const plan = (revision: string): InferencePlan => ({
  schemaVersion: 1,
  revision,
  mode: "zero-retention",
  modes: [{ id: "zero-retention", label: "Alexandria Zero Data Retention", allowed: true, current: true }],
  models: [{ id: "gemma-4-31b", label: "Gemma 4 31B", kind: "chat", capabilities: { vision: true, tools: true, reasoning: false } }],
  jobs: { memory: { default: "gemma-4-31b", choices: ["gemma-4-31b"], fallbacks: [], visibility: "default" } },
});

const ok = (body: unknown, etag: string | null = "\"e1\""): InferencePlanFetchResult => ({ kind: "ok", etag, body });

describe("BridgeInferencePlanCache", () => {
  test("keys the plan by WorkOS user and organization", () => {
    expect(inferencePlanOwnerKey(session)).toBe("user_a:org_valen");
    expect(inferencePlanOwnerKey({ ...session, organizationId: null })).toBe("user_a:personal");
  });

  test("returns null when signed out without fetching", async () => {
    const fetch = vi.fn();
    const cache = new BridgeInferencePlanCache({ fetch });
    await expect(cache.read(null)).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("serves a fresh plan from memory, then revalidates with the ETag after 60 s", async () => {
    let now = 1_000;
    const fetch = vi.fn<(token: string, etag: string | null) => Promise<InferencePlanFetchResult>>()
      .mockResolvedValueOnce(ok(plan("c1.p1")))
      .mockResolvedValueOnce({ kind: "not_modified" });
    const cache = new BridgeInferencePlanCache({ fetch, nowMs: () => now });
    const first = await cache.read(session);
    expect(first).toMatchObject({ state: "ready", plan: { revision: "c1.p1" }, evaluatedFor: { userId: "user_a", organizationId: "org_valen" } });
    now += 59_000;
    await cache.read(session);
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 2_000;
    const revalidated = await cache.read(session);
    expect(fetch).toHaveBeenLastCalledWith("session_a", "\"e1\"");
    expect(revalidated).toMatchObject({ state: "ready", plan: { revision: "c1.p1" }, fetchedAt: new Date(now).toISOString() });
  });

  test("answers null for a Cloud without the plan and does not ask again while fresh", async () => {
    const fetch = vi.fn(async (): Promise<InferencePlanFetchResult> => ({ kind: "not_found" }));
    const cache = new BridgeInferencePlanCache({ fetch, nowMs: () => 5_000 });
    await expect(cache.read(session)).resolves.toBeNull();
    await expect(cache.read(session)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("keeps the last good plan as stale when a refresh fails, and backs off", async () => {
    let now = 1_000;
    const onError = vi.fn();
    const fetch = vi.fn<(token: string, etag: string | null) => Promise<InferencePlanFetchResult>>()
      .mockResolvedValueOnce(ok(plan("c1.p1")))
      .mockRejectedValueOnce(new AuthServerTimeoutError(15_000))
      .mockResolvedValueOnce(ok({ schemaVersion: 2 }));
    const cache = new BridgeInferencePlanCache({ fetch, nowMs: () => now, onError });
    await cache.read(session);
    now += 61_000;
    await expect(cache.read(session)).resolves.toMatchObject({ state: "stale", plan: { revision: "c1.p1" } });
    await cache.read(session);
    expect(fetch).toHaveBeenCalledTimes(2);
    // An invalid body is a failure too: the last good plan stays.
    await expect(cache.read(session, { force: true })).resolves.toMatchObject({ state: "stale", plan: { revision: "c1.p1" } });
    expect(onError).toHaveBeenCalledTimes(2);
  });

  test("returns null after a failure with no plan, and never sends an ETag for a plan it does not hold", async () => {
    const fetch = vi.fn<(token: string, etag: string | null) => Promise<InferencePlanFetchResult>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok(plan("c1.p2")));
    const cache = new BridgeInferencePlanCache({ fetch, nowMs: () => 1_000 });
    await expect(cache.read(session)).resolves.toBeNull();
    await expect(cache.read(session, { force: true })).resolves.toMatchObject({ plan: { revision: "c1.p2" } });
    expect(fetch.mock.calls.map((call) => call[1])).toEqual([null, null]);
  });

  test("drops the plan when the account changes and never returns a plan fetched for another account", async () => {
    let release!: (value: InferencePlanFetchResult) => void;
    const fetch = vi.fn<(token: string, etag: string | null) => Promise<InferencePlanFetchResult>>()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce(ok(plan("datalab")));
    const cache = new BridgeInferencePlanCache({ fetch, nowMs: () => 1_000 });
    const pending = cache.read(session);
    const other = { ...session, sessionToken: "session_b", organizationId: "org_datalab" };
    const switched = await cache.read(other);
    release(ok(plan("valen")));
    await expect(pending).resolves.toBeNull();
    expect(switched).toMatchObject({ plan: { revision: "datalab" }, evaluatedFor: { organizationId: "org_datalab" } });
    await expect(cache.read(other)).resolves.toMatchObject({ plan: { revision: "datalab" } });
  });

  test("coalesces concurrent reads and clears on sign-out", async () => {
    const fetch = vi.fn(async (): Promise<InferencePlanFetchResult> => ok(plan("c1.p1")));
    const cache = new BridgeInferencePlanCache({ fetch, nowMs: () => 1_000 });
    const [left, right] = await Promise.all([cache.read(session), cache.read(session)]);
    expect(left).toEqual(right);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(cache.read(null)).resolves.toBeNull();
    await cache.read(session);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
