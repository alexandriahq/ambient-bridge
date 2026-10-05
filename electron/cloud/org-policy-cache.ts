import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  desktopGlobalControlSchema,
  desktopOrgPolicyResponseSchema,
  desktopOrgPolicySchema,
  globalControlApplies,
  globalControlTargetKey,
  type DesktopGlobalControl,
  type DesktopOrgPolicy,
} from "@alexandria/cloud-contract";

/**
 * Bridge-side copy of the organization's published Cloud policy
 * (`GET /v1/org-policy`, ADR-0295). One entry for the signed-in organization;
 * the last good document per organization is kept on disk so an offline start
 * keeps the org's locks. A policy evaluated for another organization is never
 * applied.
 *
 * Global controls (ADR-0296) ride the same response: Alexandria-wide kills
 * already resolved for this organization. They are kept (and persisted) even
 * when the organization has no published policy; expired entries are dropped
 * from every snapshot and a timer re-emits when the next one expires.
 */

export type BridgeOrgPolicyState = "none" | "loading" | "ready" | "stale" | "error";

export type BridgeOrgPolicyStatus = {
  readonly state: BridgeOrgPolicyState;
  readonly evaluatedFor: { readonly organizationId: string | null };
  readonly policy: DesktopOrgPolicy | null;
  /** Active global controls for this organization (expired ones removed). */
  readonly globalControls: DesktopGlobalControl[];
  /** ISO time of the last successful Cloud answer (200 or 304). */
  readonly fetchedAt: string | null;
};

export type OrgPolicyFetchResult =
  | { readonly kind: "not_modified" }
  | { readonly kind: "ok"; readonly etag: string | null; readonly body: unknown };

export type OrgPolicyCacheSession = {
  readonly organizationId: string | null;
  readonly sessionToken: string;
};

export type BridgeOrgPolicyCacheOptions = {
  /** Directory for per-organization last-good documents. */
  readonly directory: string;
  readonly fetch: (sessionToken: string, etag: string | null) => Promise<OrgPolicyFetchResult>;
  readonly nowMs?: () => number;
  /** A successful answer younger than this is reused unless forced. */
  readonly freshMs?: number;
  /** Unforced retries after a failure wait at least this long (status reads are frequent). */
  readonly retryMs?: number;
  readonly onChange?: () => void;
};

type Entry = {
  readonly organizationId: string;
  state: BridgeOrgPolicyState;
  policy: DesktopOrgPolicy | null;
  globalControls: readonly DesktopGlobalControl[];
  etag: string | null;
  fetchedAtMs: number | null;
  attemptedAtMs: number | null;
};

const DISK_SCHEMA_VERSION = 1;

export class OrgPolicyMismatchError extends Error {
  constructor() {
    super("Cloud returned an organization policy for a different organization.");
    this.name = "OrgPolicyMismatchError";
  }
}

export class BridgeOrgPolicyCache {
  #entry: Entry | null = null;
  #generation = 0;
  #inFlight: { readonly organizationId: string; readonly generation: number; readonly promise: Promise<BridgeOrgPolicyStatus> } | null = null;
  #lastSignature = "";
  #expiryTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #options: BridgeOrgPolicyCacheOptions;
  readonly #nowMs: () => number;
  readonly #freshMs: number;
  readonly #retryMs: number;

  constructor(options: BridgeOrgPolicyCacheOptions) {
    this.#options = options;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#freshMs = options.freshMs ?? 60_000;
    this.#retryMs = options.retryMs ?? 15_000;
  }

  /** Status for `organizationId`; never another organization's policy. */
  snapshot(organizationId: string | null): BridgeOrgPolicyStatus {
    const org = normalizeOrganizationId(organizationId);
    if (!org) return { state: "none", evaluatedFor: { organizationId: null }, policy: null, globalControls: [], fetchedAt: null };
    const entry = this.#entry;
    if (!entry || entry.organizationId !== org) {
      return { state: "loading", evaluatedFor: { organizationId: org }, policy: null, globalControls: [], fetchedAt: null };
    }
    return {
      state: entry.state,
      evaluatedFor: { organizationId: org },
      policy: entry.policy,
      globalControls: this.#activeControls(entry),
      fetchedAt: entry.fetchedAtMs === null ? null : new Date(entry.fetchedAtMs).toISOString(),
    };
  }

  /** Policy document for `organizationId` when one is known (fresh or last good). */
  policyFor(organizationId: string | null | undefined): DesktopOrgPolicy | null {
    const org = normalizeOrganizationId(organizationId);
    const entry = this.#entry;
    if (!org || !entry || entry.organizationId !== org) return null;
    return entry.policy?.workosOrganizationId === org ? entry.policy : null;
  }

  /** Active global controls for `organizationId`; [] for personal sessions or another organization. */
  globalControlsFor(organizationId: string | null | undefined): DesktopGlobalControl[] {
    const org = normalizeOrganizationId(organizationId);
    const entry = this.#entry;
    if (!org || !entry || entry.organizationId !== org) return [];
    return this.#activeControls(entry);
  }

  /** Stops the expiry timer (shutdown, tests). */
  dispose(): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
  }

  /** Drops the in-memory entry (sign-out, organization switch). Disk last-good stays per organization. */
  clear(): void {
    this.#generation += 1;
    this.#entry = null;
    this.#inFlight = null;
    this.#emitIfChanged();
  }

  async refresh(
    session: OrgPolicyCacheSession | null,
    options: { readonly force?: boolean } = {},
  ): Promise<BridgeOrgPolicyStatus> {
    const org = normalizeOrganizationId(session?.organizationId);
    if (!session || !org) {
      if (this.#entry) this.clear();
      return this.snapshot(null);
    }
    if (this.#entry?.organizationId !== org) {
      this.#generation += 1;
      this.#inFlight = null;
      this.#entry = { organizationId: org, state: "loading", policy: null, globalControls: [], etag: null, fetchedAtMs: null, attemptedAtMs: null };
      const generation = this.#generation;
      const stored = await this.#readDisk(org);
      if (generation !== this.#generation) return this.snapshot(org);
      if (stored) {
        this.#entry = {
          organizationId: org,
          // Restored records are stale (refetched) even when they hold only global controls.
          state: "stale",
          policy: stored.policy,
          globalControls: stored.globalControls,
          etag: stored.etag,
          fetchedAtMs: stored.fetchedAtMs,
          attemptedAtMs: null,
        };
      }
      this.#emitIfChanged();
    }
    const entry = this.#entry!;
    const fresh = entry.fetchedAtMs !== null && this.#nowMs() - entry.fetchedAtMs < this.#freshMs
      && (entry.state === "ready" || entry.state === "none");
    const backingOff = entry.attemptedAtMs !== null && this.#nowMs() - entry.attemptedAtMs < this.#retryMs;
    if (!options.force && (fresh || backingOff)) return this.snapshot(org);
    if (this.#inFlight?.organizationId === org && this.#inFlight.generation === this.#generation) {
      return this.#inFlight.promise;
    }
    const generation = this.#generation;
    const promise = this.#load(org, session.sessionToken, generation).finally(() => {
      if (this.#inFlight?.promise === promise) this.#inFlight = null;
    });
    this.#inFlight = { organizationId: org, generation, promise };
    return promise;
  }

  async #load(org: string, sessionToken: string, generation: number): Promise<BridgeOrgPolicyStatus> {
    const etag = this.#entry?.organizationId === org ? this.#entry.etag : null;
    if (this.#entry?.organizationId === org) this.#entry.attemptedAtMs = this.#nowMs();
    try {
      const result = await this.#options.fetch(sessionToken, etag);
      if (generation !== this.#generation || this.#entry?.organizationId !== org) return this.snapshot(org);
      const entry = this.#entry!;
      if (result.kind === "not_modified") {
        entry.state = entry.policy ? "ready" : "none";
        entry.fetchedAtMs = this.#nowMs();
      } else {
        const parsed = desktopOrgPolicyResponseSchema.safeParse(result.body);
        if (!parsed.success) throw new Error("Cloud organization policy response was invalid.");
        const policy = parsed.data.orgPolicy;
        if (policy && policy.workosOrganizationId !== org) throw new OrgPolicyMismatchError();
        entry.policy = policy;
        entry.globalControls = parsed.data.globalControls;
        entry.etag = result.etag;
        entry.state = policy ? "ready" : "none";
        entry.fetchedAtMs = this.#nowMs();
        await this.#writeDisk(org, entry).catch(() => undefined);
        if (generation !== this.#generation) return this.snapshot(org);
      }
    } catch (error) {
      if (generation === this.#generation && this.#entry?.organizationId === org) {
        this.#entry.state = this.#entry.policy ? "stale" : "error";
        this.#emitIfChanged();
      }
      throw error;
    }
    this.#emitIfChanged();
    return this.snapshot(org);
  }

  #emitIfChanged(): void {
    const entry = this.#entry;
    const signature = entry
      ? [
          entry.organizationId,
          entry.state,
          entry.policy?.version ?? "",
          entry.policy?.publishedAt ?? "",
          globalControlsSignature(this.#activeControls(entry)),
        ].join("|")
      : "";
    this.#scheduleExpiry();
    if (signature === this.#lastSignature) return;
    this.#lastSignature = signature;
    this.#options.onChange?.();
  }

  #activeControls(entry: Entry): DesktopGlobalControl[] {
    const nowMs = this.#nowMs();
    return entry.globalControls.filter((control) => globalControlApplies(control, entry.organizationId, nowMs));
  }

  /** Re-emits when the next active control expires, so clients lift it without waiting for a poll. */
  #scheduleExpiry(): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
    const entry = this.#entry;
    if (!entry) return;
    const nowMs = this.#nowMs();
    let next = Number.POSITIVE_INFINITY;
    for (const control of this.#activeControls(entry)) {
      const expiresAtMs = control.expiresAt === null ? Number.NaN : Date.parse(control.expiresAt);
      if (Number.isFinite(expiresAtMs) && expiresAtMs > nowMs) next = Math.min(next, expiresAtMs);
    }
    if (!Number.isFinite(next)) return;
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = null;
      this.#emitIfChanged();
    }, Math.min(next - nowMs + 50, 2_147_000_000));
    this.#expiryTimer.unref?.();
  }

  #path(org: string): string {
    return join(this.#options.directory, `${org.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  }

  async #readDisk(org: string): Promise<{
    policy: DesktopOrgPolicy | null;
    globalControls: DesktopGlobalControl[];
    etag: string | null;
    fetchedAtMs: number | null;
  } | null> {
    try {
      const record = JSON.parse(await readFile(this.#path(org), "utf8")) as Record<string, unknown>;
      if (record.schemaVersion !== DISK_SCHEMA_VERSION || record.organizationId !== org) return null;
      // Records written before global controls have no field: no kills.
      const globalControls = parseGlobalControls(record.globalControls);
      let policy: DesktopOrgPolicy | null = null;
      if (record.orgPolicy !== null && record.orgPolicy !== undefined) {
        const parsed = desktopOrgPolicySchema.safeParse(record.orgPolicy);
        if (!parsed.success || parsed.data.workosOrganizationId !== org) return null;
        policy = parsed.data;
      }
      if (!policy && globalControls.length === 0) return null;
      const fetchedAtMs = typeof record.fetchedAt === "string" ? Date.parse(record.fetchedAt) : Number.NaN;
      return {
        policy,
        globalControls,
        etag: typeof record.etag === "string" ? record.etag : null,
        fetchedAtMs: Number.isFinite(fetchedAtMs) ? fetchedAtMs : null,
      };
    } catch {
      return null;
    }
  }

  async #writeDisk(org: string, entry: Entry): Promise<void> {
    const target = this.#path(org);
    if (!entry.policy && entry.globalControls.length === 0) {
      await rm(target, { force: true });
      return;
    }
    await mkdir(this.#options.directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      schemaVersion: DISK_SCHEMA_VERSION,
      organizationId: org,
      etag: entry.etag,
      fetchedAt: entry.fetchedAtMs === null ? null : new Date(entry.fetchedAtMs).toISOString(),
      orgPolicy: entry.policy,
      globalControls: entry.globalControls,
    })}\n`, { mode: 0o600 });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function parseGlobalControls(value: unknown): DesktopGlobalControl[] {
  if (!Array.isArray(value)) return [];
  const controls: DesktopGlobalControl[] = [];
  for (const candidate of value) {
    const parsed = desktopGlobalControlSchema.safeParse(candidate);
    if (parsed.success) controls.push(parsed.data);
  }
  return controls;
}

/** Order-independent; notice and expiry included so an edited control re-emits. */
export function globalControlsSignature(controls: readonly DesktopGlobalControl[]): string {
  return controls
    .map((control) => `${globalControlTargetKey(control.target)}~${control.notice ?? ""}~${control.expiresAt ?? ""}`)
    .sort()
    .join(",");
}

function normalizeOrganizationId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
