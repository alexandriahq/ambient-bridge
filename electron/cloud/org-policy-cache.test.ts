import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { emptyOrgPolicy, type DesktopGlobalControl, type DesktopOrgPolicy } from "@alexandria/cloud-contract";
import { bridgeShellStatusSignature } from "../shell-status-signature.js";
import { BridgeOrgPolicyCache, globalControlsSignature, OrgPolicyMismatchError, type OrgPolicyFetchResult } from "./org-policy-cache.js";

const claudeOff: DesktopGlobalControl = { target: { kind: "provider", id: "claude" }, notice: null, expiresAt: null };
const agentsOff: DesktopGlobalControl = { target: { kind: "feature", key: "agents" }, notice: "Agents are paused.", expiresAt: null };

function published(org: string, version = 1): DesktopOrgPolicy {
  return {
    workosOrganizationId: org,
    organizationName: `Org ${org}`,
    version,
    publishedAt: "2026-10-01T00:00:00.000Z",
    policy: { ...emptyOrgPolicy(), features: { actionsCapture: true } },
  };
}

describe("BridgeOrgPolicyCache", () => {
  let directory: string;
  let now: number;
  let calls: Array<{ token: string; etag: string | null }>;
  let responses: Array<OrgPolicyFetchResult | Error>;
  let changes: number;

  const cache = () => new BridgeOrgPolicyCache({
    directory,
    nowMs: () => now,
    onChange: () => { changes += 1; },
    fetch: async (token, etag) => {
      calls.push({ token, etag });
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      if (next instanceof Error) throw next;
      return next;
    },
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "org-policy-cache-"));
    now = 1_000_000;
    calls = [];
    responses = [];
    changes = 0;
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("personal sessions have no policy and never fetch", async () => {
    const status = await cache().refresh({ organizationId: null, sessionToken: "t" });
    expect(status).toEqual({ state: "none", evaluatedFor: { organizationId: null }, policy: null, globalControls: [], fetchedAt: null });
    expect(calls).toEqual([]);
  });

  test("fetches, persists last good, then polls with If-None-Match", async () => {
    const subject = cache();
    responses.push({ kind: "ok", etag: "\"org_a:1\"", body: { orgPolicy: published("org_a") } });
    const first = await subject.refresh({ organizationId: "org_a", sessionToken: "t1" });
    expect(first.state).toBe("ready");
    expect(first.policy?.version).toBe(1);
    expect(subject.policyFor("org_a")?.version).toBe(1);
    expect(subject.policyFor("org_b")).toBeNull();
    expect(await readdir(directory)).toEqual(["org_a.json"]);

    // Fresh within 60s: no request.
    now += 30_000;
    await subject.refresh({ organizationId: "org_a", sessionToken: "t1" });
    expect(calls).toHaveLength(1);

    now += 31_000;
    responses.push({ kind: "not_modified" });
    const polled = await subject.refresh({ organizationId: "org_a", sessionToken: "t2" });
    expect(calls[1]).toEqual({ token: "t2", etag: "\"org_a:1\"" });
    expect(polled.state).toBe("ready");
    expect(polled.fetchedAt).toBe(new Date(now).toISOString());
  });

  test("restores last good from disk and reports stale while Cloud is unreachable", async () => {
    responses.push({ kind: "ok", etag: "\"org_a:3\"", body: { orgPolicy: published("org_a", 3) } });
    await cache().refresh({ organizationId: "org_a", sessionToken: "t" });

    const restarted = cache();
    expect(restarted.snapshot("org_a").state).toBe("loading");
    responses.push(new TypeError("fetch failed"));
    await expect(restarted.refresh({ organizationId: "org_a", sessionToken: "t" })).rejects.toThrow("fetch failed");
    const status = restarted.snapshot("org_a");
    expect(status.state).toBe("stale");
    expect(status.policy?.version).toBe(3);
    expect(calls.at(-1)?.etag).toBe("\"org_a:3\"");
  });

  test("an org-bound user with no policy ever fetched gets error and no policy; retries back off", async () => {
    const subject = cache();
    responses.push(new TypeError("offline"));
    await expect(subject.refresh({ organizationId: "org_a", sessionToken: "t" })).rejects.toThrow();
    expect(subject.snapshot("org_a")).toMatchObject({ state: "error", policy: null });
    // Frequent status reads do not hammer Cloud while it is down.
    await subject.refresh({ organizationId: "org_a", sessionToken: "t" });
    expect(calls).toHaveLength(1);
    now += 15_000;
    responses.push({ kind: "ok", etag: "a", body: { orgPolicy: published("org_a") } });
    expect((await subject.refresh({ organizationId: "org_a", sessionToken: "t" })).state).toBe("ready");
  });

  test("switching organizations never exposes the previous organization's policy", async () => {
    const subject = cache();
    responses.push({ kind: "ok", etag: "a", body: { orgPolicy: published("org_a") } });
    await subject.refresh({ organizationId: "org_a", sessionToken: "t" });
    responses.push({ kind: "ok", etag: "b", body: { orgPolicy: null } });
    const status = await subject.refresh({ organizationId: "org_b", sessionToken: "t" });
    expect(status).toMatchObject({ state: "none", policy: null, evaluatedFor: { organizationId: "org_b" } });
    expect(subject.snapshot("org_a")).toMatchObject({ state: "loading", policy: null });
    expect(subject.policyFor("org_a")).toBeNull();
    expect(calls[1]?.etag).toBeNull();
  });

  test("rejects a policy evaluated for a different organization", async () => {
    const subject = cache();
    responses.push({ kind: "ok", etag: "x", body: { orgPolicy: published("org_other") } });
    await expect(subject.refresh({ organizationId: "org_a", sessionToken: "t" })).rejects.toBeInstanceOf(OrgPolicyMismatchError);
    expect(subject.policyFor("org_a")).toBeNull();
    expect(subject.snapshot("org_a").state).toBe("error");
  });

  test("a response that lands after an organization switch is discarded", async () => {
    let release!: (value: OrgPolicyFetchResult) => void;
    const subject = new BridgeOrgPolicyCache({
      directory,
      nowMs: () => now,
      fetch: (_token, _etag) => new Promise((resolve) => { release = resolve; }),
    });
    const pending = subject.refresh({ organizationId: "org_a", sessionToken: "t" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    subject.clear();
    release({ kind: "ok", etag: "a", body: { orgPolicy: published("org_a") } });
    await pending;
    expect(subject.policyFor("org_a")).toBeNull();
  });

  test("clear drops memory but keeps disk last good; an empty policy deletes it", async () => {
    const subject = cache();
    responses.push({ kind: "ok", etag: "a", body: { orgPolicy: published("org_a") } });
    await subject.refresh({ organizationId: "org_a", sessionToken: "t" });
    subject.clear();
    expect(subject.policyFor("org_a")).toBeNull();
    expect(JSON.parse(await readFile(join(directory, "org_a.json"), "utf8")).organizationId).toBe("org_a");

    responses.push({ kind: "ok", etag: "none", body: { orgPolicy: null } });
    await subject.refresh({ organizationId: "org_a", sessionToken: "t" }, { force: true });
    expect(await readdir(directory)).toEqual([]);
    expect(changes).toBeGreaterThan(0);
  });

  describe("global controls (ADR-0296)", () => {
    test("keeps kills alongside the policy and in the snapshot", async () => {
      const subject = cache();
      responses.push({ kind: "ok", etag: "k1", body: { orgPolicy: published("org_a"), globalControls: [claudeOff] } });
      const status = await subject.refresh({ organizationId: "org_a", sessionToken: "t" });
      expect(status.globalControls).toEqual([claudeOff]);
      expect(subject.globalControlsFor("org_a")).toEqual([claudeOff]);
      expect(subject.globalControlsFor("org_b")).toEqual([]);
      expect(subject.globalControlsFor(null)).toEqual([]);
    });

    test("an older Cloud body without the field means no kills", async () => {
      const subject = cache();
      responses.push({ kind: "ok", etag: "k", body: { orgPolicy: published("org_a") } });
      expect((await subject.refresh({ organizationId: "org_a", sessionToken: "t" })).globalControls).toEqual([]);
    });

    test("an organization without a policy keeps kills, persists them and restores them offline", async () => {
      responses.push({ kind: "ok", etag: "k", body: { orgPolicy: null, globalControls: [agentsOff] } });
      const status = await cache().refresh({ organizationId: "org_a", sessionToken: "t" });
      expect(status).toMatchObject({ state: "none", policy: null, globalControls: [agentsOff] });
      expect(await readdir(directory)).toEqual(["org_a.json"]);
      const record = JSON.parse(await readFile(join(directory, "org_a.json"), "utf8"));
      expect(record).toMatchObject({ orgPolicy: null, globalControls: [agentsOff] });

      const restarted = cache();
      responses.push(new TypeError("offline"));
      await expect(restarted.refresh({ organizationId: "org_a", sessionToken: "t" })).rejects.toThrow();
      expect(restarted.snapshot("org_a")).toMatchObject({ state: "error", policy: null, globalControls: [agentsOff] });
    });

    test("lifting every kill without a policy deletes the disk record", async () => {
      const subject = cache();
      responses.push({ kind: "ok", etag: "k", body: { orgPolicy: null, globalControls: [agentsOff] } });
      await subject.refresh({ organizationId: "org_a", sessionToken: "t" });
      responses.push({ kind: "ok", etag: "k2", body: { orgPolicy: null, globalControls: [] } });
      await subject.refresh({ organizationId: "org_a", sessionToken: "t" }, { force: true });
      expect(await readdir(directory)).toEqual([]);
    });

    test("a last-good record written before global controls restores with no kills", async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "org_a.json"), JSON.stringify({
        schemaVersion: 1, organizationId: "org_a", etag: "old", fetchedAt: null, orgPolicy: published("org_a", 2),
      }));
      const subject = cache();
      responses.push(new TypeError("offline"));
      await expect(subject.refresh({ organizationId: "org_a", sessionToken: "t" })).rejects.toThrow();
      expect(subject.snapshot("org_a")).toMatchObject({ state: "stale", globalControls: [] });
      expect(subject.snapshot("org_a").policy?.version).toBe(2);
    });

    test("expired kills are dropped from snapshots and a change re-emits", async () => {
      const subject = cache();
      const expiring: DesktopGlobalControl = { ...claudeOff, expiresAt: new Date(now + 60_000).toISOString() };
      responses.push({ kind: "ok", etag: "k", body: { orgPolicy: null, globalControls: [expiring] } });
      await subject.refresh({ organizationId: "org_a", sessionToken: "t" });
      expect(subject.snapshot("org_a").globalControls).toEqual([expiring]);
      now += 61_000;
      expect(subject.snapshot("org_a").globalControls).toEqual([]);
      subject.dispose();
    });

    test("a kill change alone changes the cache and shell signatures", async () => {
      const subject = cache();
      responses.push({ kind: "ok", etag: "k1", body: { orgPolicy: published("org_a"), globalControls: [] } });
      await subject.refresh({ organizationId: "org_a", sessionToken: "t" });
      const before = changes;
      now += 61_000;
      responses.push({ kind: "ok", etag: "k2", body: { orgPolicy: published("org_a"), globalControls: [claudeOff] } });
      await subject.refresh({ organizationId: "org_a", sessionToken: "t" });
      expect(changes).toBe(before + 1);

      const shell = (controls: readonly DesktopGlobalControl[]) => bridgeShellStatusSignature({
        accountSignature: "a", activeRequests: 0, attestation: "", attestationInProgress: false, authError: "",
        lastError: "", lastRequestId: "", lastRequestStatus: "", loginPending: false, plaintextInferenceWarningHidden: false,
        inferenceAvailability: { state: "ready" },
        nodeRouting: {
          state: "ready", organizationId: "org_a", workspaceId: null, workspaceKind: null, installationId: null, origin: null,
          capabilities: [], entitlements: { inference: true, multiplayer: false, publishing: false, mcp: false },
          inferenceMode: null, configurationVersion: null, message: null,
        },
        orgPolicy: { state: "ready", evaluatedFor: { organizationId: "org_a" }, policy: null, globalControlsSignature: globalControlsSignature(controls) },
        pairedClients: 0, pendingPairingRequests: 0, reachability: "reachable", sessionRefreshAttempt: 0,
        sessionRefreshState: "idle", socketReady: true, wireCaptureRevision: 0,
      });
      expect(shell([claudeOff])).not.toBe(shell([]));
      expect(shell([claudeOff, agentsOff])).toBe(shell([agentsOff, claudeOff]));
      expect(shell([{ ...agentsOff, notice: "Other" }])).not.toBe(shell([agentsOff]));
    });
  });
});
