import { describe, expect, test, vi } from "vitest";
import { defaultInferenceModelAssignment } from "@ambient/shared/inference-models";
import type { UsagePricingCatalog, UsageSummary } from "@ambient/shared/usage";
import type { SignedInWorkOsSession } from "../workos/session.js";
import { BridgeModelAssignmentCache } from "./model-assignment-cache.js";
import { BridgePricingCache } from "./pricing-cache.js";
import { BridgeUsageCache } from "./usage-cache.js";

const session: SignedInWorkOsSession = {
  kind: "signed_in", sessionToken: "test", expiresAt: 2_000_000_000,
  organizationId: "org_a", email: "test@example.test",
  user: { id: "user_a", email: "test@example.test", name: null },
};
const summary = (owner: SignedInWorkOsSession, version: string): UsageSummary => ({
  schemaVersion: 1, currency: "USD", period: { kind: "lifetime" }, mode: "metered",
  owner: owner.organizationId ? { kind: "organization", id: owner.organizationId } : { kind: "user", id: owner.user.id },
  grantedMicros: "100", usedMicros: "0", reservedMicros: "0", remainingMicros: version,
  updatedAt: "2026-07-20T12:00:00.000Z",
});
const outcome = <T>(promise: Promise<T>) => promise.then(value => ({ value }), error => ({ error }));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

interface Cache<Value> {
  clear(): void;
  read(input: {
    session: SignedInWorkOsSession | null;
    force?: boolean;
    load: (session: SignedInWorkOsSession) => Promise<Value>;
  }): Promise<unknown>;
}

function lifecycle<Value>(
  name: string,
  create: (ttl: number, now: () => number) => Cache<Value>,
  value: (owner: SignedInWorkOsSession, version: string) => Value,
  ready: (value: Value, time: number, state?: "ready" | "stale") => unknown,
  retired: unknown,
): void {
  describe(`${name} cache lifecycle`, () => {
    test("fresh reads precede a forced refresh; overlapping loads share their exact Promise", async () => {
      let now = 1_000;
      const clock = vi.fn(() => now);
      const cache = create(100, clock);
      const first = value(session, "10");
      const initial = cache.read({ session, load: async () => first });
      await expect(initial).resolves.toEqual(ready(first, now));
      if (name === "pricing") expect(await initial).toBe(first);
      const pending = deferred<Value>();
      const load = vi.fn(() => pending.promise);
      const refresh = cache.read({ session, force: true, load });
      const rotated = { ...session, sessionToken: "rotated", user: { ...session.user, id: "user_b" } };
      expect(cache.read({ session: rotated, force: true, load })).toBe(refresh);
      const cachedRead = cache.read({ session, load });
      expect(cachedRead).not.toBe(refresh);
      await expect(cachedRead).resolves.toEqual(ready(first, now));
      now = 1_100;
      expect(cache.read({ session, load })).toBe(refresh);
      expect(load).toHaveBeenCalledTimes(1);
      now = 1_200;
      const second = value(session, "20");
      pending.resolve(second);
      await expect(refresh).resolves.toEqual(ready(second, now));
      await expect(cache.read({ session, load })).resolves.toEqual(ready(second, now));
      expect(load).toHaveBeenCalledTimes(1);
    });

    test.each(["clear", "signout", "organization", "user"].flatMap(boundary =>
      [false, true].map(newFirst => ({ boundary, newFirst })),
    ))("$boundary retires old success (replacement settles first: $newFirst)", async ({ boundary, newFirst }) => {
      const cache = create(100, () => 1_000);
      const owner = boundary === "user" ? { ...session, organizationId: null } : session;
      const oldLoad = deferred<Value>();
      const old = outcome(cache.read({ session: owner, load: () => oldLoad.promise }));
      if (boundary === "clear") cache.clear();
      if (boundary === "signout") {
        const neverLoad = vi.fn(async () => value(owner, "0"));
        await outcome(cache.read({ session: null, load: neverLoad }));
        expect(neverLoad).not.toHaveBeenCalled();
      }
      const replacement = boundary === "organization" ? { ...owner, organizationId: "org_b" }
        : boundary === "user" ? { ...owner, user: { ...owner.user, id: "user_b" } } : owner;
      const nextLoad = deferred<Value>();
      const load = vi.fn(() => nextLoad.promise);
      const next = cache.read({ session: replacement, load });
      const latest = value(replacement, "20");
      if (newFirst) {
        nextLoad.resolve(latest);
        await next;
      }
      oldLoad.resolve(value(owner, "10"));
      expect(await old).toEqual(retired);
      if (!newFirst) expect(cache.read({ session: replacement, force: true, load })).toBe(next);
      expect(load).toHaveBeenCalledTimes(1);
      nextLoad.resolve(latest);
      await expect(next).resolves.toEqual(ready(latest, 1_000));
      await expect(cache.read({ session: replacement, load })).resolves.toEqual(ready(latest, 1_000));
    });

    test.each([false, true])("late failures use only the current same-owner fallback (changed owner: %s)", async changed => {
      const cache = create(100, () => 1_000);
      const oldLoad = deferred<Value>();
      const old = outcome(cache.read({ session, load: () => oldLoad.promise }));
      cache.clear();
      const owner = changed ? { ...session, organizationId: "org_b" } : session;
      const latest = value(owner, "20");
      await cache.read({ session: owner, load: async () => latest });
      const error = new Error("load failed");
      oldLoad.reject(error);
      const result = await old;
      if (name === "pricing") expect("error" in result && result.error).toBe(error);
      else expect(result).toEqual(changed ? retired : { value: ready(latest, 1_000, "stale") });
      await expect(cache.read({ session: owner, load: async () => { throw error; } }))
        .resolves.toEqual(ready(latest, 1_000));
    });
  });
}

lifecycle("usage", (ttl, now) => new BridgeUsageCache(ttl, now), summary,
  (summary, time, state = "ready") => ({ state, summary, fetchedAt: new Date(time).toISOString() }),
  { value: { state: "unavailable", reason: "server_error" } });
lifecycle("models", (ttl, now) => new BridgeModelAssignmentCache(ttl, now),
  (_owner, version) => ({ ...defaultInferenceModelAssignment(), version }),
  (assignment, time, state = "ready") => ({ state, source: "server", assignment, fetchedAt: new Date(time).toISOString() }),
  { value: { state: "offline_default", source: "baked", assignment: defaultInferenceModelAssignment(), fetchedAt: null, reason: "server_error" } });
lifecycle("pricing", (ttl, now) => new BridgePricingCache(ttl, now),
  (_owner, version): UsagePricingCatalog => ({ schemaVersion: 1, version, prices: [] }), value => value,
  { error: new Error("Inference pricing owner changed while loading.") });

test("usage observation keeps a same-owner flight and retires it when the observed owner changes", async () => {
  const cache = new BridgeUsageCache(100, () => 1_000);
  const observe = vi.spyOn(cache, "observe");
  const pending = deferred<UsageSummary>();
  const load = vi.fn(() => pending.promise);
  const flight = cache.read({ session, load });
  const observed = summary(session, "30");
  cache.observe(observed, 990);
  expect(cache.read({ session, force: true, load })).toBe(flight);
  const observedRead = cache.read({ session, load });
  expect(observedRead).not.toBe(flight);
  await expect(observedRead).resolves.toEqual({ state: "ready", summary: observed, fetchedAt: new Date(990).toISOString() });
  const completed = summary(session, "20");
  pending.resolve(completed);
  await flight;
  expect(observe).toHaveBeenLastCalledWith(completed);
  const retired = deferred<UsageSummary>();
  const old = cache.read({ session, force: true, load: () => retired.promise });
  const other = { ...session, organizationId: "org_b" };
  const latest = summary(other, "40");
  cache.observe(latest);
  retired.resolve(completed);
  await expect(old).resolves.toEqual({ state: "unavailable", reason: "server_error" });
  await expect(cache.read({ session: other, load })).resolves.toMatchObject({ state: "ready", summary: latest });
});

test.each([false, true])("model response parsing preserves the fallback (cached: %s)", async cached => {
  const cache = new BridgeModelAssignmentCache(100, () => 1_000);
  const assignment = { ...defaultInferenceModelAssignment(), version: "valid" };
  if (cached) await cache.read({ session, load: async () => assignment });
  const invalid = { ...assignment, version: "" };
  await expect(cache.read({ session, force: true, load: async () => invalid })).resolves.toEqual(cached
    ? { state: "stale", source: "server", assignment, fetchedAt: new Date(1_000).toISOString() }
    : { state: "offline_default", source: "baked", assignment: defaultInferenceModelAssignment(), fetchedAt: null, reason: "server_error" });
});

test("a retired malformed model response still uses the current same-owner stale fallback", async () => {
  const cache = new BridgeModelAssignmentCache(100, () => 1_000);
  const pending = deferred<ReturnType<typeof defaultInferenceModelAssignment>>();
  const old = cache.read({ session, load: () => pending.promise });
  cache.clear();
  const assignment = { ...defaultInferenceModelAssignment(), version: "new" };
  await cache.read({ session, load: async () => assignment });
  pending.resolve({ ...assignment, version: "" });
  await expect(old).resolves.toEqual({ state: "stale", source: "server", assignment, fetchedAt: new Date(1_000).toISOString() });
});
