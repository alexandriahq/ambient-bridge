import { Context, Data, Effect } from "effect";
import {
  cloudBootstrapResponseSchema,
  type CloudBootstrapReadyResponse,
  type CloudNodeCapability,
  type CloudWorkspaceEntitlements,
  type CloudWorkspaceKind,
} from "@alexandria/cloud-contract";
import type { SignedInWorkOsSession } from "../workos/session.js";

export type CloudNodeRoute = {
  readonly source: "alexandria_cloud" | "legacy";
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly workspaceId: string | null;
  readonly workspaceKind: CloudWorkspaceKind | null;
  readonly workosOrganizationId: string | null;
  readonly installationId: string | null;
  readonly capabilities: readonly CloudNodeCapability[];
  readonly entitlements: CloudWorkspaceEntitlements;
  /**
   * The Node's default mode (bootstrap `inferenceMode`). A request without its
   * own `inferenceMode` runs in it; one with it runs in that mode (ADR-0313).
   */
  readonly inferenceMode: "confidential" | "plaintext";
  readonly configurationVersion: number | null;
  readonly expiresAtMs: number;
};

export type CloudNodeRoutingState =
  | "unknown"
  | "resolving"
  | "ready"
  | "legacy"
  | "no_organization"
  | "organization_selection_required"
  | "node_not_provisioned"
  | "seat_limit_reached"
  | "authentication_required"
  | "unavailable";

export type CloudNodeRoutingSnapshot = {
  readonly state: CloudNodeRoutingState;
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly workspaceKind: CloudWorkspaceKind | null;
  readonly installationId: string | null;
  readonly origin: string | null;
  readonly capabilities: readonly CloudNodeCapability[];
  readonly entitlements: CloudWorkspaceEntitlements;
  readonly inferenceMode: "confidential" | "plaintext" | null;
  readonly configurationVersion: number | null;
  readonly message: string | null;
};

/** User-facing copy shared by Bridge status and the app's seat-limit card. */
export const SEAT_LIMIT_MESSAGE = "Your organization has no free Ambient seats. Ask your admin to add a seat.";

export class CloudNodeRoutingError extends Data.TaggedError("CloudNodeRoutingError")<{
  readonly code: Exclude<CloudNodeRoutingState, "unknown" | "resolving" | "ready" | "legacy">;
  readonly message: string;
  readonly status?: number;
}> {}

export interface CloudNodeRoutingServiceShape {
  readonly resolve: (
    session: SignedInWorkOsSession,
    options?: { readonly force?: boolean },
  ) => Effect.Effect<CloudNodeRoute, CloudNodeRoutingError>;
  readonly invalidate: () => Effect.Effect<void>;
  readonly snapshot: () => Effect.Effect<CloudNodeRoutingSnapshot>;
}

export class CloudNodeRoutingService extends Context.Tag("bridge/CloudNodeRoutingService")<
  CloudNodeRoutingService,
  CloudNodeRoutingServiceShape
>() {}

/** Inference requires an authoritative Cloud assignment, including in development. */
export function inferenceRouteFromAssignment(route: CloudNodeRoute): CloudNodeRoute {
  if (route.source !== "legacy") return route;
  throw routingError("unavailable", "Alexandria Cloud bootstrap is required for Node inference.");
}

/** Stable cache boundary for identity/config. Membership ids participate even
 * when no organization is active, so gaining or losing membership cannot
 * reuse a personal or organization-scoped Node identity. */
export function cloudNodeSessionBoundaryKey(session: SignedInWorkOsSession): string {
  const memberships = [...new Set(
    (session.organizations ?? [])
      .map((organization) => organization.id.trim())
      .filter(Boolean),
  )].sort();
  return `${session.user.id}:${session.organizationId?.trim() || "none"}:${memberships.join(",")}`;
}

export function createCloudNodeRoutingService(options: {
  readonly cloudBaseUrl: string;
  readonly legacyMultiplayerBaseUrl: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly refreshSkewMs?: number;
  readonly requestTimeoutMs?: number;
  readonly onRotatedSessionToken?: (
    token: string,
    expectedSession: SignedInWorkOsSession,
  ) => Promise<void>;
  readonly onStateChange?: (snapshot: CloudNodeRoutingSnapshot) => void;
  /** Reported on `/v1/bootstrap` so Cloud records member activity. */
  readonly appVersion?: string;
  readonly platform?: string;
}): CloudNodeRoutingServiceShape {
  const cloudBaseUrl = stripSlash(options.cloudBaseUrl);
  const legacyBaseUrl = options.legacyMultiplayerBaseUrl
    ? stripSlash(options.legacyMultiplayerBaseUrl)
    : null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  let cached: { readonly key: string; readonly route: CloudNodeRoute } | null = null;
  let pending: { readonly key: string; readonly promise: Promise<CloudNodeRoute> } | null = null;
  let activeBoundaryKey: string | null = null;
  let boundaryGeneration = 0;
  let state: CloudNodeRoutingSnapshot = emptySnapshot("unknown", null);

  const publish = (next: CloudNodeRoutingSnapshot) => {
    state = next;
    options.onStateChange?.(next);
  };

  const resolvePromise = async (
    session: SignedInWorkOsSession,
    force: boolean,
  ): Promise<CloudNodeRoute> => {
    const organizationId = session.organizationId?.trim() || null;
    const key = cloudNodeSessionBoundaryKey(session);
    if (activeBoundaryKey !== key) {
      activeBoundaryKey = key;
      boundaryGeneration += 1;
      cached = null;
      pending = null;
    }
    if (
      !force
      && cached?.key === key
      && cached.route.expiresAtMs > now() + (options.refreshSkewMs ?? 30_000)
    ) {
      return cached.route;
    }
    if (!force && pending?.key === key) return pending.promise;

    const requestGeneration = boundaryGeneration;
    publish({ ...emptySnapshot("resolving", organizationId), origin: state.origin });
    const request = fetchImpl(`${cloudBaseUrl}/v1/bootstrap`, {
      method: "POST",
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? 8_000),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${session.sessionToken}`,
        ...(options.appVersion ? { "x-ambient-app-version": options.appVersion } : {}),
        ...(options.platform ? { "x-ambient-platform": options.platform } : {}),
      },
    }).then(async (response) => {
      if (requestGeneration !== boundaryGeneration) {
        throw routingError("unavailable", "Cloud Node bootstrap was discarded after an account boundary changed.");
      }
      if (response.status === 404 && legacyBaseUrl) {
        const route: CloudNodeRoute = {
          source: "legacy",
          baseUrl: legacyBaseUrl,
          accessToken: session.sessionToken,
          workspaceId: null,
          workspaceKind: organizationId ? "workos_org" : null,
          workosOrganizationId: organizationId,
          installationId: null,
          capabilities: ["multiplayer", "mcp"],
          entitlements: { inference: false, multiplayer: true, publishing: true, mcp: true },
          inferenceMode: "confidential",
          configurationVersion: null,
          expiresAtMs: Math.min(session.expiresAt * 1_000, now() + 5 * 60_000),
        };
        cached = { key, route };
        publish({
          state: "legacy",
          organizationId,
          workspaceId: null,
          workspaceKind: route.workspaceKind,
          installationId: null,
          origin: originOf(legacyBaseUrl),
          capabilities: route.capabilities,
          entitlements: route.entitlements,
          inferenceMode: route.inferenceMode,
          configurationVersion: null,
          message: "Using the staged legacy Multiplayer destination until Cloud bootstrap is deployed.",
        });
        return route;
      }
      if (response.status === 401) {
        throw routingError("authentication_required", "Alexandria Cloud rejected the Bridge session.", 401);
      }
      if (!response.ok) {
        throw routingError("unavailable", `Alexandria Cloud bootstrap failed (${response.status}).`, response.status);
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw routingError("unavailable", "Alexandria Cloud returned an invalid bootstrap response.", response.status);
      }
      const parsed = cloudBootstrapResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw routingError("unavailable", "Alexandria Cloud returned an invalid bootstrap contract.", response.status);
      }
      const body = parsed.data;
      if (body.status !== "ready") {
        if (requestGeneration !== boundaryGeneration) {
          throw routingError("unavailable", "Cloud Node bootstrap was discarded after an account boundary changed.");
        }
        const rotated = body.rotatedSessionToken;
        if (rotated && rotated !== session.sessionToken) {
          await options.onRotatedSessionToken?.(rotated, session);
        }
        if (body.status === "seat_limit_reached") {
          throw routingError("seat_limit_reached", SEAT_LIMIT_MESSAGE, response.status);
        }
        const message = body.status === "no_organization"
          ? "This account does not belong to an organization."
          : body.status === "organization_selection_required"
            ? "Select an organization in Ambient before using organization services."
            : "Alexandria Node is not provisioned for this workspace.";
        throw routingError(body.status, message, response.status);
      }
      return readyRoute(body, session, key);
    }).catch((error: unknown) => {
      if (error instanceof CloudNodeRoutingError) throw error;
      throw routingError("unavailable", "Alexandria Cloud bootstrap is unreachable.");
    }).finally(() => {
      if (pending?.promise === request) pending = null;
    });
    pending = { key, promise: request };

    try {
      return await request;
    } catch (error) {
      const routed = error instanceof CloudNodeRoutingError
        ? error
        : routingError("unavailable", "Alexandria Cloud bootstrap is unavailable.");
      if (requestGeneration !== boundaryGeneration) throw routed;
      cached = null;
      publish({
        ...emptySnapshot(routed.code, organizationId),
        message: routed.message,
      });
      throw routed;
    }

    async function readyRoute(
      body: CloudBootstrapReadyResponse,
      activeSession: SignedInWorkOsSession,
      cacheKey: string,
    ): Promise<CloudNodeRoute> {
      if (requestGeneration !== boundaryGeneration) {
        throw routingError("unavailable", "Cloud Node bootstrap was discarded after an account boundary changed.");
      }
      if (body.identity.claims.sub !== activeSession.user.id) {
        throw routingError("authentication_required", "Cloud identity does not match the active Bridge user.");
      }
      if (organizationId) {
        const publicFallback = body.workspace.kind === "personal"
          && body.workspace.workosOrganizationId === null;
        if (
          !publicFallback
          && (body.workspace.kind !== "workos_org" || body.workspace.workosOrganizationId !== organizationId)
        ) {
          throw routingError("authentication_required", "Cloud workspace does not match the active organization.");
        }
      } else if (body.workspace.kind === "workos_org") {
        if (!body.identity.rotatedSessionToken) {
          throw routingError("authentication_required", "Cloud activated an organization without rotating the Bridge session.");
        }
      } else if (body.workspace.kind !== "personal" || body.workspace.workosOrganizationId !== null) {
        throw routingError("authentication_required", "Cloud returned an invalid personal workspace binding.");
      }
      const expiresAtMs = Date.parse(body.identity.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()) {
        throw routingError("authentication_required", "Cloud Node identity is already expired.");
      }
      if (body.identity.rotatedSessionToken && body.identity.rotatedSessionToken !== activeSession.sessionToken) {
        await options.onRotatedSessionToken?.(body.identity.rotatedSessionToken, activeSession);
      }
      if (requestGeneration !== boundaryGeneration) {
        throw routingError("unavailable", "Cloud Node bootstrap was discarded after an account boundary changed.");
      }
      const route: CloudNodeRoute = {
        source: "alexandria_cloud",
        baseUrl: stripSlash(body.node.apiBaseUrl),
        accessToken: body.identity.accessToken,
        workspaceId: body.workspace.id,
        workspaceKind: body.workspace.kind,
        workosOrganizationId: body.workspace.workosOrganizationId,
        installationId: body.node.installationId,
        capabilities: body.node.capabilities,
        entitlements: {
          inference: body.entitlements.inference,
          multiplayer: body.entitlements.multiplayer,
          publishing: body.entitlements.publishing,
          mcp: body.entitlements.mcp,
        },
        inferenceMode: body.node.inferenceMode,
        configurationVersion: body.node.configurationVersion,
        expiresAtMs,
      };
      cached = { key: cacheKey, route };
      publish({
        state: "ready",
        organizationId: body.workspace.workosOrganizationId,
        workspaceId: body.workspace.id,
        workspaceKind: body.workspace.kind,
        installationId: body.node.installationId,
        origin: originOf(route.baseUrl),
        capabilities: route.capabilities,
        entitlements: route.entitlements,
        inferenceMode: route.inferenceMode,
        configurationVersion: route.configurationVersion,
        message: null,
      });
      return route;
    }
  };

  return {
    resolve: (session, input = {}) => Effect.tryPromise({
      try: () => resolvePromise(session, input.force === true),
      catch: (error) => error instanceof CloudNodeRoutingError
        ? error
        : routingError("unavailable", "Alexandria Cloud bootstrap failed."),
    }),
    invalidate: () => Effect.sync(() => {
      boundaryGeneration += 1;
      activeBoundaryKey = null;
      cached = null;
      pending = null;
      publish(emptySnapshot("unknown", null));
    }),
    snapshot: () => Effect.sync(() => ({ ...state, capabilities: [...state.capabilities] })),
  };
}

function routingError(
  code: CloudNodeRoutingError["code"],
  message: string,
  status?: number,
): CloudNodeRoutingError {
  return new CloudNodeRoutingError({ code, message, ...(status === undefined ? {} : { status }) });
}

function emptySnapshot(
  state: CloudNodeRoutingState,
  organizationId: string | null,
): CloudNodeRoutingSnapshot {
  return {
    state,
    organizationId,
    workspaceId: null,
    workspaceKind: null,
    installationId: null,
    origin: null,
    capabilities: [],
    entitlements: { inference: false, multiplayer: false, publishing: false, mcp: false },
    inferenceMode: null,
    configurationVersion: null,
    message: null,
  };
}

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
