import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeFeatureFlagSlugs } from "@ambient/shared/feature-flags";
import { Effect } from "effect";
import ts from "typescript";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { AuthServerClient } from "../electron/auth/server-client.js";
import { cloudNodeSessionBoundaryKey } from "../electron/cloud/node-assignment.js";
import { errorMessage } from "../electron/error-message.js";
import { workOsSessionExpiresAtSeconds, type SignedInWorkOsSession, type WorkOsSession } from "../electron/workos/session.js";
import { EncryptedSessionStore } from "../electron/workos/token-store.js";

vi.hoisted(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network access"); })));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rm: vi.fn(actual.rm) };
});

// Execute complete main declarations without Electron bootstrap. Only external
// effects are supplied; the real auth parser, store queue and boundary key run.
const original = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("main.ts", original, ts.ScriptTarget.Latest, true);
const names = ["inferenceAdmissions", "organizationsRefresh", "inferenceGeneration", "refreshOrganizations", "refreshOrganizationsOnce",
  "readSignedInSession", "writeSignedInSessionIfCurrent", "toStoredSession", "mergeFeatureFlagsByOrganization",
  "featureFlagSummary", "safeStatusMessage", "clearInferenceTransparency"];
const declarations = (name: string) => source.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && node.name?.text === name)
  || (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1
    && node.declarationList.declarations[0]!.name.getText(source) === name));
// The error recorder is absent in the frozen pre-fix source used by the regression proof.
if (declarations("recordOrganizationsRefreshFailure").length) names.push("recordOrganizationsRefreshFailure");
const bodies = names.map(name => {
  const matches = declarations(name);
  if (matches.length !== 1) throw new Error(`Expected one complete main declaration: ${name}`);
  return original.slice(matches[0]!.getStart(source), matches[0]!.getEnd());
}).join("\n\n");
const emitted = ts.transpileModule(`
  const { Effect, cloudNodeSessionBoundaryKey, sanitizeFeatureFlagSlugs, workOsSessionExpiresAtSeconds,
    errorMessage, sessionStore, authServer, audit, notifyStatusChanged, publishRequestLogReset,
    activeInferenceRequests, activeAttestationChecks, networkHistory, wireTap, initialInferenceStatus,
    inferenceAvailability, bridgeUsageCache, bridgeModelAssignmentCache, bridgeInferencePlanCache, bridgeOrgPolicyCache, bridgePricingCache, cloudNodeRouting } = deps;
  let inferenceStatus;
  ${bodies}
  return { refreshOrganizations, clearInferenceTransparency, generation: () => inferenceGeneration };
`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None }, reportDiagnostics: true });
if (emitted.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) {
  throw new Error("Main organizations declarations did not transpile");
}
const createMain = new Function("deps", emitted.outputText) as
  (deps: Record<string, unknown>) => { refreshOrganizations(): Promise<void>; clearInferenceTransparency(): void; generation(): number };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Fixture phase timed out")), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
const crypto = { encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(), isEncryptionAvailable: () => true };
function signedIn(id = "A", overrides: Partial<SignedInWorkOsSession> = {}): SignedInWorkOsSession {
  return { kind: "signed_in", email: `${id}@example.test`, user: { id, email: `${id}@example.test`, name: id },
    expiresAt: 2_000_000_000, sessionToken: `token-${id}`, organizationId: `org-${id}`,
    organizations: [{ id: `org-${id}`, name: id }], featureFlagsByOrganization: { retained: ["old"] }, ...overrides };
}
function listing(session = signedIn(), rotate = true, extraMembership = false) {
  return { organizationId: session.organizationId, organizations: [
    { id: session.organizationId, name: "Updated" }, ...(extraMembership ? [{ id: "added", name: "Added" }] : []),
  ], featureFlagsByOrganization: [{ organizationId: session.organizationId, featureFlags: ["new", "new"] }],
  session: rotate ? { ...session, sessionToken: `rotated-${session.sessionToken}`, featureFlags: ["current"] } : null };
}
const cleanups: (() => Promise<void>)[] = [];
afterAll(() => vi.unstubAllGlobals());
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
  finally { vi.restoreAllMocks(); vi.clearAllMocks(); }
});

async function fixture(initial: WorkOsSession = signedIn()) {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "bridge-organizations-"));
  const path = join(root, "synthetic-session.enc");
  const store = new EncryptedSessionStore(path, crypto);
  await store.write(initial);
  const requests: { body: { sessionToken: string; includeFeatureFlags: boolean }; response: ReturnType<typeof deferred<Response>> }[] = [];
  const jobs: Promise<unknown>[] = [];
  const releases: (() => void)[] = [];
  let closed = false;
  const requestSignals = Array.from({ length: 8 }, () => deferred<void>());
  const fetchImpl: typeof fetch = async (url, init) => {
    if (closed) return Response.json({ error: "Fixture closed" }, { status: 503 });
    expect(String(url)).toBe("https://auth.example.test/auth/organizations");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body.includeFeatureFlags).toBe(true);
    const response = deferred<Response>();
    requests.push({ body, response });
    requestSignals[requests.length - 1]!.resolve();
    return response.promise;
  };
  const audit = { record: vi.fn() }, notify = vi.fn(), reset = vi.fn();
  const clearable = { clear: vi.fn() };
  const main = createMain({ Effect, cloudNodeSessionBoundaryKey, sanitizeFeatureFlagSlugs,
    workOsSessionExpiresAtSeconds, errorMessage, sessionStore: () => store,
    authServer: new AuthServerClient({ baseUrl: "https://auth.example.test", fetchImpl }), audit,
    notifyStatusChanged: notify, publishRequestLogReset: reset, activeInferenceRequests: { abortAll: vi.fn() },
    activeAttestationChecks: new Set(), networkHistory: clearable, wireTap: clearable,
    initialInferenceStatus: () => ({}), inferenceAvailability: { clearAccount: vi.fn() },
    bridgeUsageCache: clearable, bridgeModelAssignmentCache: clearable, bridgeInferencePlanCache: clearable, bridgeOrgPolicyCache: clearable, bridgePricingCache: clearable,
    cloudNodeRouting: { invalidate: () => Effect.void } });
  const track = <T>(job: Promise<T>): Promise<T> => { jobs.push(job); return job; };
  const gate = () => {
    const entered = deferred<void>(), released = deferred<void>();
    releases.push(() => released.resolve());
    return { entered: entered.promise, release: () => released.resolve(), wait: async () => {
      entered.resolve(); await released.promise;
    } };
  };
  cleanups.push(async () => {
    closed = true;
    for (const release of releases) release();
    for (const request of requests) request.response.resolve(Response.json({ error: "Fixture closed" }, { status: 503 }));
    try { await within(Promise.allSettled(jobs)); }
    finally { await actual.rm(root, { force: true, recursive: true }); }
  });
  return { store, audit, notify, reset, main, requests, track, gate,
    refresh: () => track(main.refreshOrganizations()),
    request: async (index = 0) => { await within(requestSignals[index]!.promise); return requests[index]!; },
    respond: (index = 0, body = listing(), status = 200) => requests[index]!.response.resolve(Response.json(body, { status })),
    durable: () => new EncryptedSessionStore(path, crypto).read(),
    boundary: () => { main.clearInferenceTransparency(); audit.record.mockClear(); notify.mockClear(); reset.mockClear(); },
    holdWrite: () => {
      const hold = gate();
      vi.mocked(writeFile).mockImplementationOnce(async (...args) => { await hold.wait(); await actual.writeFile(...args); });
      return hold;
    },
    holdClear: () => {
      const hold = gate();
      vi.mocked(rm).mockImplementation(async (...args) => {
        // Atomic saves also remove a temporary file. Hold only the queued
        // sign-out deletion, after the preceding session write has committed.
        if (args[0] === path) await hold.wait();
        await actual.rm(...args);
      });
      return hold;
    },
  };
}
function expectUnpublished(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.audit.record.mock.calls.filter(([event]) => event === "auth.organizations_refreshed")).toEqual([]);
  expect(f.notify).not.toHaveBeenCalled();
  expect(f.reset).not.toHaveBeenCalled();
}

test.each([true, false])("persists current directory and valid server rotation=%s", async rotate => {
  const f = await fixture(), pending = f.refresh();
  expect((await f.request()).body.sessionToken).toBe("token-A");
  f.respond(0, listing(signedIn(), rotate, true)); await within(pending);
  expect(await f.durable()).toMatchObject({ sessionToken: rotate ? "rotated-token-A" : "token-A",
    organizationName: "Updated", organizations: [{ id: "org-A", name: "Updated" }, { id: "added", name: "Added" }],
    featureFlagsByOrganization: { retained: ["old"], "org-A": ["new"] } });
  expect(f.reset).toHaveBeenCalledOnce();
  expect(f.notify).toHaveBeenCalledTimes(2);
  expect(f.audit.record).toHaveBeenCalledWith("auth.organizations_refreshed", expect.objectContaining({ count: 2 }));
});

test.each([true, false])("rebases a token rotated during HTTP; response rotation=%s", async rotate => {
  const f = await fixture(), pending = f.refresh(); await f.request();
  await f.store.write(signedIn("A", { sessionToken: "concurrent-rotation" }));
  f.respond(0, listing(signedIn(), rotate)); await within(pending);
  expect(await f.durable()).toMatchObject({ sessionToken: rotate ? "rotated-token-A" : "concurrent-rotation",
    organizations: [{ id: "org-A", name: "Updated" }] });
  expect(f.reset).not.toHaveBeenCalled(); expect(f.notify).toHaveBeenCalledOnce();
});

const replacements = [
  ["another account", signedIn("B"), false],
  ["same-user relogin", signedIn("A", { sessionToken: "relogin" }), true],
  ["same-user relogin retaining token", signedIn(), true],
  ["organization switch retaining token", signedIn("A", { organizationId: "other" }), false],
  ["membership change retaining token", signedIn("A", { organizations: [{ id: "other", name: "Other" }] }), false],
] as const;
test.each(replacements)("discards a listing after %s", async (_, replacement, advance) => {
  const f = await fixture(), pending = f.refresh(); await f.request();
  await f.store.write(replacement); if (advance) f.boundary();
  f.respond(); await within(pending);
  expect(await f.store.read()).toEqual(replacement); expect(await f.durable()).toEqual(replacement);
  expectUnpublished(f);
});

test("discards a directory-only reply after account replacement", async () => {
  const f = await fixture(), pending = f.refresh(); await f.request();
  await f.store.write(signedIn("B")); f.respond(0, listing(signedIn(), false)); await within(pending);
  expect(await f.durable()).toEqual(signedIn("B")); expectUnpublished(f);
});

test("sign-out during HTTP keeps the store signed out", async () => {
  const f = await fixture(), pending = f.refresh(); await f.request(); await f.store.clear();
  f.respond(); await within(pending);
  expect(await f.durable()).toEqual({ kind: "signed_out" }); expectUnpublished(f);
});

test("does not start a request when the initial read crosses a generation", async () => {
  const f = await fixture(), read = deferred<WorkOsSession>();
  vi.spyOn(f.store, "read").mockImplementationOnce(() => read.promise);
  const pending = f.refresh(); f.boundary(); read.resolve(signedIn());
  await new Promise(setImmediate); expect(f.requests).toHaveLength(0);
  await within(pending); expectUnpublished(f);
});

test.each([false, true])("new account refresh starts immediately and survives old completion; failure=%s", async failure => {
  const f = await fixture(), old = f.refresh(); await f.request();
  await f.store.write(signedIn("B")); f.boundary();
  const current = f.refresh(); await new Promise(setImmediate);
  expect(f.requests).toHaveLength(2); expect((await f.request(1)).body.sessionToken).toBe("token-B");
  f.respond(0, listing(), failure ? 503 : 200); await within(old); expectUnpublished(f);
  const joined = f.refresh(); await new Promise(setImmediate);
  expect(f.requests).toHaveLength(2);
  f.respond(1, listing(signedIn("B"))); await within(Promise.all([current, joined]));
  expect(await f.durable()).toMatchObject({ user: { id: "B" }, sessionToken: "rotated-token-B" });
  expect(f.notify).toHaveBeenCalledOnce();
});

test("a changed boundary in the same generation waits, then refreshes the current account", async () => {
  const f = await fixture(), old = f.refresh(); await f.request();
  await f.store.write(signedIn("B")); const current = f.refresh(); await new Promise(setImmediate);
  expect(f.requests).toHaveLength(1); f.respond(); await within(old);
  expect(await f.durable()).toEqual(signedIn("B")); expectUnpublished(f);
  expect((await f.request(1)).body.sessionToken).toBe("token-B");
  f.respond(1, listing(signedIn("B"))); await within(current);
  expect(await f.durable()).toMatchObject({ user: { id: "B" }, sessionToken: "rotated-token-B" });
});

test("coalesces same-boundary requests and can retry after an HTTP failure", async () => {
  const f = await fixture(), first = f.refresh(), joined = f.refresh(); await f.request();
  f.respond(0, listing(), 503); await within(Promise.all([first, joined]));
  expect(f.requests).toHaveLength(1); expect(await f.durable()).toEqual(signedIn());
  expect(f.audit.record).toHaveBeenCalledWith("auth.organizations_refresh_failed", expect.any(Object));
  const retry = f.refresh(); await f.request(1); f.respond(1); await within(retry);
  expect(await f.durable()).toMatchObject({ sessionToken: "rotated-token-A" });
});

test.each(["generation", "membership", "token"])("rechecks %s when the write reaches the real store queue", async change => {
  const f = await fixture(), pending = f.refresh(); await f.request();
  const hold = f.holdWrite();
  const replacement = change === "membership" ? signedIn("A", { organizations: [{ id: "other", name: "Other" }] })
    : change === "token" ? signedIn("A", { sessionToken: "new-token" }) : signedIn();
  const writing = f.track(f.store.write(replacement)); await within(hold.entered);
  const queued = deferred<void>(), write = f.store.writeIfCurrent.bind(f.store);
  vi.spyOn(f.store, "writeIfCurrent").mockImplementation((...args) => { const job = write(...args); queued.resolve(); return job; });
  f.respond(); await within(queued.promise); if (change === "generation") f.boundary();
  hold.release(); await within(Promise.all([writing, pending]));
  expect(await f.durable()).toEqual(replacement); expectUnpublished(f);
  expect(f.audit.record).toHaveBeenCalledWith("auth.session_write_skipped", expect.objectContaining({ state: "session_changed" }));
});

test("an admitted old write finishes before replacement, without old publication", async () => {
  const f = await fixture(), pending = f.refresh(); await f.request();
  const hold = f.holdWrite(); f.respond(0, listing(signedIn(), true, true)); await within(hold.entered);
  f.boundary(); const replacement = f.track(f.store.write(signedIn("B")));
  hold.release(); await within(Promise.all([pending, replacement]));
  expect(await f.durable()).toEqual(signedIn("B")); expectUnpublished(f);
});

test("queued clear suppresses old publication before sign-out advances the generation", async () => {
  const f = await fixture(), pending = f.refresh(); await f.request();
  const write = f.holdWrite(); f.respond(0, listing(signedIn(), true, true)); await within(write.entered);
  const removal = f.holdClear(), clearing = f.track(f.store.clear()); write.release();
  await within(removal.entered); await within(pending);
  expect(f.store.peekCached()).toEqual({ kind: "signed_out" });
  expect(f.main.generation()).toBe(0); expectUnpublished(f);
  removal.release(); await within(clearing); expect(await f.durable()).toEqual({ kind: "signed_out" });
});

test.each(["token rotation", "new refresh"])("committed membership invalidation survives a later %s", async next => {
  const f = await fixture(), pending = f.refresh(); await f.request();
  const committed = f.gate(), write = f.store.writeIfCurrent.bind(f.store);
  // Hold only the return from a completed real write, exposing the publication phase.
  vi.spyOn(f.store, "writeIfCurrent").mockImplementationOnce(async (...args) => {
    const result = await write(...args); await committed.wait(); return result;
  });
  f.respond(0, listing(signedIn(), true, true)); await within(committed.entered);
  const saved = await f.store.read(); expect(saved.kind).toBe("signed_in");
  let followup: Promise<void> | undefined;
  if (next === "token rotation") {
    await f.store.write({ ...saved as SignedInWorkOsSession, sessionToken: "later-rotation" });
  } else {
    followup = f.refresh(); await new Promise(setImmediate);
    expect(f.requests).toHaveLength(1);
  }
  committed.release(); await within(pending);
  expect(f.reset).toHaveBeenCalledOnce(); expect(f.notify).toHaveBeenCalledTimes(2);
  if (followup) { await within(followup); expect(f.requests).toHaveLength(1); }
  expect(await f.durable()).toMatchObject({ organizations: listing(signedIn(), true, true).organizations,
    sessionToken: next === "token rotation" ? "later-rotation" : "rotated-token-A" });
  expect(f.reset).toHaveBeenCalledOnce(); expect(f.notify).toHaveBeenCalledTimes(2);
});

test("an initial read failure remains best effort and can retry", async () => {
  const f = await fixture(); vi.spyOn(f.store, "read").mockRejectedValueOnce(new Error("Read failed"));
  await within(f.refresh()); expect(f.requests).toHaveLength(0);
  expect(f.audit.record).toHaveBeenCalledWith("auth.organizations_refresh_failed", { message: "Read failed" });
  const retry = f.refresh(); await f.request(); f.respond(); await within(retry);
  expect(await f.durable()).toMatchObject({ sessionToken: "rotated-token-A" });
});

test("signed-out refresh is a no-op", async () => {
  const f = await fixture({ kind: "signed_out" }); await within(f.refresh());
  expect(f.requests).toHaveLength(0); expectUnpublished(f);
});
