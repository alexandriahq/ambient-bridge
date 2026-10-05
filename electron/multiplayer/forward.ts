import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { AuditSink } from "../diagnostics/audit.js";
import type { JsonValue } from "../ipc-server/protocol.js";
import { shouldRefreshWorkOsSession, type SignedInWorkOsSession, type WorkOsSession } from "../workos/session.js";

export const WORKOS_ORGANIZATION_NAME_HEADER = "x-multiplayer-workos-organization-name";

export type MultiplayerForwarderOptions = {
  multiplayerBaseUrl: string | null;
  resolveRoute?: (session: SignedInWorkOsSession) => Promise<MultiplayerResolvedRoute>;
  onNodeUnauthorized?: () => Promise<void>;
  audit: AuditSink;
  readSession: () => Promise<WorkOsSession>;
  refreshSession: (session: SignedInWorkOsSession) => Promise<WorkOsSession>;
  onUnauthorized: (reason: string, session: SignedInWorkOsSession) => Promise<boolean>;
  onResponse?: (response: Response) => Promise<void>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  instanceId?: string;
  instanceLabel?: string;
  appVersion?: string;
};

export type MultiplayerResolvedRoute = {
  readonly source: "alexandria_cloud" | "legacy";
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly capabilities: readonly ("multiplayer" | "publishing" | "inference" | "mcp")[];
  readonly entitlements: {
    readonly inference: boolean;
    readonly multiplayer: boolean;
    readonly publishing: boolean;
    readonly mcp: boolean;
  };
};

type RoutedPermission = "multiplayer" | "publishing" | "mcp";

export type MultiplayerMcpConnectionState =
  | "unconfigured"
  | "signed_out"
  | "reachable"
  | "not_provisioned"
  | "waiting_for_admin"
  | "unreachable"
  | "error";

export type MultiplayerMcpStatusPayload = {
  configured: boolean;
  origin: string | null;
  signedIn: boolean;
  state: MultiplayerMcpConnectionState;
  lastError: string | null;
  checkedAtMs: number;
};

export type MultiplayerEffectivePolicyPayload = {
  orgId: string;
  userId: string;
  control: string | null;
  layers: JsonValue;
  /** ADR-0168 company profile; null from Nodes that predate profiles. The
   * desktop validates the shape; Bridge only forwards an object. */
  companyProfile: JsonValue | null;
};

export type MultiplayerHeartbeatPayload = {
  instanceId: string | null;
};

export type MultiplayerPublishPayload = {
  uploadPart?: { sha256: string; index: number };
  accepted: {
    memories: number;
    chunks: number;
    intents: number;
    handoffs: number;
    recordings: number;
  };
};

export type MultiplayerEncryptionPayload = {
  orgId: string;
  profile: string;
  required: boolean;
  kmsProvider: string | null;
  kmsKeyId: string | null;
};

export async function forwardMultiplayerEncryption(
  requestId: string,
  options: MultiplayerForwarderOptions,
): Promise<MultiplayerEncryptionPayload> {
  const { session } = await requirePublisherSession(requestId, "multiplayer.encryption", options, "multiplayer");
  const body = await multiplayerJson(options, session, "GET", "/v1/me/encryption", undefined, requestId, "multiplayer");
  const orgId = stringField(body, "orgId");
  const profile = stringField(body, "profile");
  if (!orgId || !profile) {
    throw new Error("Multiplayer did not return encryption settings.");
  }
  const kmsProvider = stringField(body, "kmsProvider");
  const kmsKeyId = stringField(body, "kmsKeyId");
  options.audit.record("multiplayer.encryption_complete", { requestId, orgId, profile });
  return {
    orgId,
    profile,
    required: body.required === true,
    kmsProvider,
    kmsKeyId,
  };
}

export async function forwardMultiplayerEffectivePolicy(
  requestId: string,
  options: MultiplayerForwarderOptions,
): Promise<MultiplayerEffectivePolicyPayload> {
  const { session } = await requirePublisherSession(requestId, "multiplayer.effective_policy", options, "multiplayer");
  const body = await multiplayerJson(options, session, "GET", "/v1/me/effective-policy", undefined, requestId, "multiplayer");
  const orgId = stringField(body, "orgId");
  const userId = stringField(body, "userId");
  const effective = objectField(body, "effective");
  const layers = effective ? (effective.layers as JsonValue) : null;
  if (!orgId || !userId || !layers || typeof layers !== "object" || Array.isArray(layers)) {
    throw new Error("Multiplayer did not return an effective sharing policy.");
  }
  const control = typeof (layers as { control?: unknown }).control === "string"
    ? (layers as { control: string }).control
    : null;
  const companyProfile = objectField(body, "companyProfile");
  options.audit.record("multiplayer.effective_policy_complete", { requestId, orgId, control,
    profile: typeof companyProfile?.profile === "string" ? companyProfile.profile : null });
  return { orgId, userId, control, layers, companyProfile: (companyProfile as JsonValue | null) ?? null };
}

export async function forwardMultiplayerPublish(
  requestId: string,
  payload: JsonValue | undefined,
  options: MultiplayerForwarderOptions,
): Promise<MultiplayerPublishPayload> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Multiplayer publish payload must be a JSON object.");
  }
  const { session } = await requirePublisherSession(requestId, "multiplayer.publish", options, "publishing");
  const body = await multiplayerJson(options, session, "POST", "/v1/me/publish", payload, requestId, "publishing");
  const accepted = parseAccepted(objectField(body, "accepted"));
  options.audit.record("multiplayer.publish_complete", {
    requestId,
    memories: accepted.memories,
    chunks: accepted.chunks,
    intents: accepted.intents,
    handoffs: accepted.handoffs,
    recordings: accepted.recordings,
  });

  const uploadPart = objectField(body, "uploadPart");
  if (uploadPart !== null) {
    if (typeof uploadPart.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(uploadPart.sha256)
        || !Number.isInteger(uploadPart.index) || Number(uploadPart.index) < 0) {
      throw new Error("Multiplayer did not confirm the recording upload part.");
    }
    return { accepted, uploadPart: { sha256: uploadPart.sha256, index: Number(uploadPart.index) } };
  }
  return { accepted };
}

// Raw capture (ADR-0167). Bridge re-checks what it can before bytes leave the
// machine: identifier shape, a closed content-type list, and that the body
// matches the manifest's length and SHA-256. The Node verifies again.
const RAW_CAPTURE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm",
  "audio/wav", "audio/ogg", "application/json", "application/x-ndjson", "text/plain"]);
export const RAW_CAPTURE_MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

export async function forwardMultiplayerRawCaptureAvailability(
  requestId: string,
  options: MultiplayerForwarderOptions,
): Promise<Record<string, unknown>> {
  const { session } = await requirePublisherSession(requestId, "multiplayer.raw_capture", options, "publishing");
  return multiplayerJson(options, session, "GET", "/v1/me/raw-capture/availability", undefined, requestId, "publishing");
}

export async function forwardMultiplayerRawCaptureUpload(
  requestId: string,
  payload: JsonValue | undefined,
  bytes: Uint8Array,
  options: MultiplayerForwarderOptions,
): Promise<Record<string, unknown>> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid raw capture upload.");
  const manifest = objectField(payload, "manifest");
  const segmentId = manifest ? stringField(manifest, "segmentId") : null;
  const contentType = manifest ? stringField(manifest, "contentType") : null;
  if (!manifest || !segmentId || !/^[A-Za-z0-9_-]{8,128}$/.test(segmentId) || !contentType || !RAW_CAPTURE_CONTENT_TYPES.has(contentType)) {
    throw new Error("Invalid raw capture manifest.");
  }
  if (!bytes.byteLength || bytes.byteLength > RAW_CAPTURE_MAX_UPLOAD_BYTES || manifest.byteLength !== bytes.byteLength
    || manifest.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
    throw new Error("Raw capture bytes do not match the manifest.");
  }
  const encoded = Buffer.from(JSON.stringify(manifest)).toString("base64url");
  if (encoded.length > 16 * 1024) throw new Error("Raw capture manifest is too large.");
  const { session } = await requirePublisherSession(requestId, "multiplayer.raw_capture", options, "publishing");
  if (("expectedWorkosOrganizationId" in payload || "expectedWorkosUserId" in payload)
    && (payload.expectedWorkosOrganizationId !== session.organizationId || payload.expectedWorkosUserId !== session.user.id)) {
    throw new Error("Raw collection account changed; queued data belongs to another identity.");
  }
  const result = await multiplayerJson({ ...options, timeoutMs: Math.max(options.timeoutMs ?? 0, 120_000) }, session, "PUT",
    `/v1/me/raw-capture/segments/${encodeURIComponent(segmentId)}`, bytes, requestId, "publishing",
    { "Content-Type": contentType, "x-ambient-raw-capture-manifest": encoded });
  options.audit.record("multiplayer.raw_capture_complete", { requestId, bytes: bytes.byteLength, duplicate: result.duplicate === true });
  return result;
}

/** Closed report operations use the same signed-in Node identity and publishing
 * entitlement as item sharing. Callers cannot supply an origin or arbitrary path.
 * The Node and desktop validate the shared report contracts at either end. */
export async function forwardMultiplayerReport(
  requestId: string,
  payload: JsonValue | undefined,
  options: MultiplayerForwarderOptions,
): Promise<Record<string, unknown>> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid report operation.");
  const operation = stringField(payload, "operation");
  const id = (key: string) => {
    const value = stringField(payload, key);
    if (!value || value.length > 200) throw new Error("Invalid report identifier.");
    return encodeURIComponent(value);
  };
  let method: "GET" | "POST" | "PUT";
  let path: string;
  let body: JsonValue | Uint8Array | undefined;
  if (operation === "availability") {
    method = "GET"; path = "/v1/me/reports/availability";
  } else if (operation === "destinations") {
    method = "GET"; path = "/v1/me/teamspaces";
  } else if (operation === "status") {
    method = "GET"; path = `/v1/me/reports/${id("publicationId")}/status`;
  } else if (operation === "withdraw") {
    const ids = payload.expectedTeamspaceIds;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some((value) => typeof value !== "string" || !value.trim() || value.length > 200)) throw new Error("Invalid report destinations.");
    method = "POST"; path = `/v1/me/reports/${id("publicationId")}/withdraw`;
    body = { expectedTeamspaceIds: ids };
  } else if (operation === "get-destinations" || operation === "set-destinations") {
    path = `/v1/me/reports/${id("publicationId")}/destinations`;
    method = operation === "get-destinations" ? "GET" : "PUT";
    if (method === "PUT") {
      for (const key of ["teamspaceIds", "expectedTeamspaceIds"]) {
        const values = payload[key];
        if (!Array.isArray(values) || values.length > 100 || values.some((value) => typeof value !== "string" || !value.trim() || value.length > 200)) throw new Error("Invalid report destinations.");
      }
      body = { teamspaceIds: payload.teamspaceIds, expectedTeamspaceIds: payload.expectedTeamspaceIds };
    }
  } else if (operation === "policy") {
    const ids = payload.teamspaceIds;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some((value) => typeof value !== "string" || !value.trim() || value.length > 200)) throw new Error("Invalid report destinations.");
    const query = new URLSearchParams();
    for (const value of ids) query.append("teamspaceId", String(value));
    method = "GET"; path = `/v1/me/reports/policy?${query}`;
  } else if (operation === "prepare" || operation === "reconcile") {
    const publication = objectField(payload, "publication");
    if (!publication || !Array.isArray(payload.teamspaceIds)) throw new Error("Invalid report preparation.");
    body = { publication: publication as JsonValue, teamspaceIds: payload.teamspaceIds };
    if (Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024) throw new Error("Report request is too large.");
    method = "POST"; path = operation === "prepare" ? "/v1/me/reports/prepare" : "/v1/me/reports/reconcile";
  } else if (operation === "part") {
    const part = payload.part;
    const encoded = payload.base64;
    if (typeof part !== "number" || !Number.isSafeInteger(part) || part < 0 || part > 5120
      || typeof encoded !== "string" || encoded.length > 1_398_104 || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error("Invalid report upload part.");
    body = Buffer.from(encoded, "base64");
    if (Buffer.from(body).toString("base64") !== encoded || !body.byteLength || body.byteLength > 1024 * 1024) throw new Error("Invalid report upload part.");
    method = "PUT"; path = `/v1/me/reports/${id("publicationId")}/assets/${id("assetId")}/parts/${part}`;
  } else if (operation === "commit") {
    method = "POST"; path = `/v1/me/reports/${id("publicationId")}/commit`;
    body = { version: "ambient-report-publication/1" };
  } else throw new Error("Unknown report operation.");
  const permission = ["reconcile", "status", "withdraw", "get-destinations"].includes(operation) ? "multiplayer" : "publishing";
  const { session } = await requirePublisherSession(requestId, "multiplayer.report", options, permission);
  const result = await multiplayerJson(options, session, method, path, body, requestId, permission);
  options.audit.record("multiplayer.report_complete", { requestId, operation });
  return result;
}

export type MultiplayerMemoryPayload = {
  memories: unknown;
};

export type MultiplayerTrajectoriesPayload = {
  trajectories: unknown;
};

export async function forwardMultiplayerMemory(
  requestId: string,
  payload: JsonValue | undefined,
  options: MultiplayerForwarderOptions,
): Promise<MultiplayerMemoryPayload> {
  const { session } = await requirePublisherSession(requestId, "multiplayer.memory", options, "mcp");
  const query = queryFromPayload(payload);
  const body = await multiplayerJson(options, session, "GET", withQuery("/v1/me/memory", query), undefined, requestId, "mcp");
  options.audit.record("multiplayer.memory_complete", { requestId });
  return { memories: Array.isArray(body.memories) ? body.memories : [] };
}

export async function forwardMultiplayerTrajectories(
  requestId: string,
  payload: JsonValue | undefined,
  options: MultiplayerForwarderOptions,
): Promise<MultiplayerTrajectoriesPayload> {
  const { session } = await requirePublisherSession(requestId, "multiplayer.trajectories", options, "mcp");
  const query = queryFromPayload(payload);
  const body = await multiplayerJson(options, session, "GET", withQuery("/v1/me/trajectories", query), undefined, requestId, "mcp");
  options.audit.record("multiplayer.trajectories_complete", { requestId });
  return { trajectories: Array.isArray(body.trajectories) ? body.trajectories : [] };
}

/** Mixed App/Bridge pair: old Ambient still sends MCP tool names over this method. */
export async function forwardMultiplayerMcp(
  requestId: string,
  payload: JsonValue | undefined,
  options: MultiplayerForwarderOptions,
): Promise<MultiplayerMemoryPayload | MultiplayerTrajectoriesPayload> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Multiplayer context payload must be a JSON object.");
  }
  const name = stringField(payload, "name");
  const args = (objectField(payload, "arguments") ?? payload) as JsonValue;
  if (name === "search_org_memories") return forwardMultiplayerMemory(requestId, args, options);
  if (name === "list_org_trajectories") return forwardMultiplayerTrajectories(requestId, args, options);
  throw new Error(name ? `Unknown Multiplayer context tool: ${name}` : "Multiplayer context payload requires a tool name.");
}

const MCP_STATUS_TIMEOUT_MS = 4_000;

/** Cheap health: resolve the active org Node, then GET `/v1/me/effective-policy`. Never throws. */
export async function forwardMultiplayerMcpStatus(
  requestId: string,
  options: MultiplayerForwarderOptions,
): Promise<MultiplayerMcpStatusPayload> {
  const checkedAtMs = Date.now();
  const configured = Boolean(options.resolveRoute || options.multiplayerBaseUrl);
  let origin = options.resolveRoute
    ? null
    : options.multiplayerBaseUrl ? originOf(options.multiplayerBaseUrl) : null;
  if (!configured) {
    options.audit.record("multiplayer.mcp_status", { requestId, state: "unconfigured" });
    return {
      configured: false,
      origin: null,
      signedIn: false,
      state: "unconfigured",
      lastError: null,
      checkedAtMs,
    };
  }

  // Read-only: a cheap health probe must not refresh (or 401-clear) the
  // WorkOS session. After an upgrade the first multiplayer.mcpStatus used to
  // race a refresh and leave capture Stopped until `ambient:prod:reset`.
  const session = await signedInSession(options, { refresh: false });
  if (!session) {
    options.audit.record("multiplayer.mcp_status", { requestId, state: "signed_out" });
    return {
      configured,
      origin,
      signedIn: false,
      state: "signed_out",
      lastError: null,
      checkedAtMs,
    };
  }

  try {
    const route = await routeForSession(options, session, "mcp");
    origin = originOf(route.baseUrl);
    const body = await multiplayerJson({
      ...options,
      timeoutMs: options.timeoutMs ?? MCP_STATUS_TIMEOUT_MS,
    }, session, "GET", "/v1/me/effective-policy", undefined, requestId, "mcp");
    if (!stringField(body, "orgId") || !stringField(body, "userId")) {
      options.audit.record("multiplayer.mcp_status", { requestId, state: "error" });
      return {
        configured,
        origin,
        signedIn: true,
        state: "error",
        lastError: "Multiplayer GET /v1/me/effective-policy returned no identity.",
        checkedAtMs,
      };
    }
    options.audit.record("multiplayer.mcp_status", { requestId, state: "reachable" });
    return {
      configured,
      origin,
      signedIn: true,
      state: "reachable",
      lastError: null,
      checkedAtMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = mcpStateFromError(message);
    options.audit.record("multiplayer.mcp_status", { requestId, state });
    return {
      configured,
      origin,
      signedIn: true,
      state,
      lastError: safeMessage(mcpStatusMessage(state, message)),
      checkedAtMs,
    };
  }
}

export async function forwardMultiplayerHeartbeat(
  requestId: string,
  options: MultiplayerForwarderOptions,
): Promise<MultiplayerHeartbeatPayload> {
  const { session } = await requirePublisherSession(requestId, "multiplayer.heartbeat", options, "multiplayer");
  const body = await multiplayerJson(options, session, "POST", "/v1/me/heartbeat", {
    instance: {
      id: options.instanceId ?? defaultMultiplayerInstanceId(),
      label: options.instanceLabel ?? "Ambient desktop",
      platform: process.platform,
      appVersion: options.appVersion ?? "0.0.0",
      status: "online",
    },
  }, requestId, "multiplayer");
  const instance = objectField(body, "instance");
  const instanceId = instance ? stringField(instance, "id") : null;
  options.audit.record("multiplayer.heartbeat_complete", { requestId, instanceId });
  return { instanceId };
}

async function requirePublisherSession(
  requestId: string,
  event: string,
  options: MultiplayerForwarderOptions,
  permission: RoutedPermission,
): Promise<{ session: SignedInWorkOsSession; baseUrl: string }> {
  if (!options.resolveRoute && !options.multiplayerBaseUrl) {
    options.audit.record(`${event}_rejected`, { reason: "unconfigured", requestId });
    throw new Error("Multiplayer sharing is not configured on Ambient Bridge.");
  }
  const session = await signedInSession(options);
  if (!session) {
    options.audit.record(`${event}_rejected`, { reason: "signed_out", requestId });
    throw new Error("Sign in to Ambient Bridge before sharing to Multiplayer.");
  }
  const route = await routeForSession(options, session, permission);
  return { session, baseUrl: route.baseUrl };
}

async function multiplayerJson(
  options: MultiplayerForwarderOptions,
  session: SignedInWorkOsSession,
  method: "GET" | "POST" | "PUT",
  path: string,
  payload: JsonValue | Uint8Array | undefined,
  requestId: string,
  permission: RoutedPermission,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const route = await routeForSession(options, session, permission);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const url = `${route.baseUrl}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${route.accessToken}`,
    ...extraHeaders,
  };
  if (session.organizationName) {
    headers[WORKOS_ORGANIZATION_NAME_HEADER] = session.organizationName.slice(0, 200);
  }
  if (payload !== undefined && !extraHeaders["Content-Type"]) headers["Content-Type"] = payload instanceof Uint8Array ? "application/octet-stream" : "application/json";

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: payload instanceof Uint8Array ? new Uint8Array(payload).buffer : payload !== undefined ? JSON.stringify(payload) : undefined,
      signal: timeoutSignal,
    });
  } catch {
    options.audit.record("multiplayer.request_unreachable", { requestId, path, method });
    throw new Error(`Multiplayer ${method} ${path} is unreachable.`);
  }

  // Only Alexandria Cloud can rotate the sealed WorkOS session. A customer
  // Node is authoritative for its short-lived identity, never Cloud auth.
  if (route.source === "legacy") await options.onResponse?.(response);

  let body: Record<string, unknown> | null = null;
  try {
    const json: unknown = await response.json();
    if (json && typeof json === "object" && !Array.isArray(json)) {
      body = json as Record<string, unknown>;
    }
  } catch {
    body = null;
  }

  if (!response.ok) {
    options.audit.record("multiplayer.request_failed", { requestId, path, method, status: response.status });
    // A customer Node can invalidate only its short-lived Cloud identity. It
    // never has authority to clear the Bridge-owned WorkOS session.
    if (response.status === 401 && route.source === "alexandria_cloud") {
      await options.onNodeUnauthorized?.();
    }
    const detail = typeof body?.error === "string" ? body.error : null;
    const hint = typeof body?.message === "string" ? body.message : null;
    throw new Error(detail
      ? `Multiplayer ${method} ${path} failed (${response.status}): ${safeMessage(detail)}${hint ? ` — ${safeMessage(hint)}` : ""}`
      : `Multiplayer ${method} ${path} failed (${response.status}).`);
  }

  return body ?? {};
}

async function routeForSession(
  options: MultiplayerForwarderOptions,
  session: SignedInWorkOsSession,
  permission: RoutedPermission,
): Promise<MultiplayerResolvedRoute> {
  if (options.resolveRoute) {
    const route = await options.resolveRoute(session);
    if (!route.capabilities.includes(permission) || !route.entitlements[permission]) {
      throw new Error(`Alexandria Node ${routedPermissionLabel(permission)} is not enabled for this workspace.`);
    }
    return route;
  }
  if (!options.multiplayerBaseUrl) {
    throw new Error("Multiplayer sharing is not configured on Ambient Bridge.");
  }
  return {
    source: "legacy",
    baseUrl: options.multiplayerBaseUrl,
    accessToken: session.sessionToken,
    capabilities: ["multiplayer", "mcp"],
    entitlements: { inference: false, multiplayer: true, publishing: true, mcp: true },
  };
}

function routedPermissionLabel(permission: RoutedPermission): string {
  switch (permission) {
    case "multiplayer": return "Multiplayer";
    case "publishing": return "Publishing";
    case "mcp": return "MCP";
  }
}

async function signedInSession(
  options: MultiplayerForwarderOptions,
  flags: { readonly refresh?: boolean } = {},
): Promise<SignedInWorkOsSession | null> {
  const session = await options.readSession();
  if (session.kind !== "signed_in") return null;
  if (flags.refresh === false || !shouldRefreshWorkOsSession(session)) return session;
  try {
    const refreshed = await options.refreshSession(session);
    return refreshed.kind === "signed_in" ? refreshed : null;
  } catch {
    return null;
  }
}

export function defaultMultiplayerInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const variant = env.AMBIENT_DESKTOP_VARIANT?.trim() || "desktop";
  const host = hostname().replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48) || "local";
  return `ambient-${variant}-${host}`;
}

function parseAccepted(value: Record<string, unknown> | null): MultiplayerPublishPayload["accepted"] {
  return {
    memories: boundedCount(value?.memories),
    chunks: boundedCount(value?.chunks),
    intents: boundedCount(value?.intents),
    handoffs: boundedCount(value?.handoffs),
    recordings: boundedCount(value?.recordings),
  };
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

function queryFromPayload(payload: JsonValue | undefined): Record<string, string> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  const query: Record<string, string> = {};
  for (const key of ["query", "limit", "teamId", "userId"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) query[key] = value.trim();
    if (typeof value === "number" && Number.isFinite(value)) query[key] = String(Math.floor(value));
  }
  return query;
}

function withQuery(path: string, query: Record<string, string>): string {
  const params = new URLSearchParams(query);
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function safeMessage(value: string): string {
  return value.slice(0, 220);
}

function mcpStateFromError(message: string): MultiplayerMcpConnectionState {
  if (/not[_ ]provisioned/i.test(message)) return "not_provisioned";
  if (message.includes("waiting_for_admin")) return "waiting_for_admin";
  if (/unreachable/i.test(message)) return "unreachable";
  if (/failed \(404\)/i.test(message) || /Application not found/i.test(message)) return "unreachable";
  return "error";
}

function mcpStatusMessage(state: MultiplayerMcpConnectionState, raw: string): string {
  if (state === "not_provisioned") {
    if (/Alexandria Node/i.test(raw)) {
      return "Alexandria Node has not been provisioned for this organization.";
    }
    return "Your IT admin has to add you in Multiplayer before you can share.";
  }
  if (state === "waiting_for_admin") {
    return "A Multiplayer admin has to open the workspace first. Ask your IT admin to sign in.";
  }
  if (state === "unreachable" && (/failed \(404\)/i.test(raw) || /Application not found/i.test(raw))) {
    return "Multiplayer ingest is not reachable at this origin.";
  }
  return raw;
}

/** Closed collection operation; the Node stamps org/user from verified identity. */
export async function forwardMultiplayerCollection(requestId: string, payload: JsonValue | undefined, options: MultiplayerForwarderOptions): Promise<JsonValue> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Collection payload must be an object.");
  const { session } = await requirePublisherSession(requestId, "multiplayer.collection", options, "publishing");
  if (payload.expectedWorkosOrganizationId !== session.organizationId || payload.expectedWorkosUserId !== session.user.id) {
    throw new Error("Collection account changed; queued data belongs to another identity.");
  }
  if (!Array.isArray(payload.records)) throw new Error("Collection records are required.");
  return await multiplayerJson(options, session, "POST", "/v1/me/collection/records", { records: payload.records }, requestId, "publishing") as JsonValue;
}
