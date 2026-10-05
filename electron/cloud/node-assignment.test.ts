import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { SignedInWorkOsSession } from "../workos/session.js";
import {
  createCloudNodeRoutingService,
  cloudNodeSessionBoundaryKey,
  inferenceRouteFromAssignment,
  type CloudNodeRoute,
} from "./node-assignment.js";

describe("Cloud Node assignment", () => {
  it("changes the identity cache boundary when organization memberships change", () => {
    const personal = session();
    const joined = {
      ...personal,
      organizations: [{ id: "org_b", name: "B" }, { id: "org_a", name: "A" }],
    };
    const reordered = {
      ...personal,
      organizations: [{ id: "org_a", name: "Renamed A" }, { id: "org_b", name: "B" }],
    };
    expect(cloudNodeSessionBoundaryKey(personal)).not.toBe(cloudNodeSessionBoundaryKey(joined));
    expect(cloudNodeSessionBoundaryKey(joined)).toBe(cloudNodeSessionBoundaryKey(reordered));
  });

  it("requires a Cloud assignment and rejects the legacy route", () => {
    const assigned = {
      source: "alexandria_cloud",
      baseUrl: "https://node.alexandria.so",
      accessToken: "identity",
      workspaceId: "ws_personal_ada",
      workspaceKind: "personal",
      workosOrganizationId: null,
      installationId: "inst_public",
      capabilities: ["inference"],
      entitlements: { inference: true, multiplayer: false, publishing: false, mcp: false },
      inferenceMode: "plaintext",
      configurationVersion: 1,
      expiresAtMs: Date.now() + 60_000,
    } satisfies CloudNodeRoute;
    expect(inferenceRouteFromAssignment(assigned)).toBe(assigned);

    const legacy = { ...assigned, source: "legacy", workspaceId: null, workspaceKind: null } satisfies CloudNodeRoute;
    expect(() => inferenceRouteFromAssignment(legacy)).toThrow(/Cloud bootstrap is required/i);
  });

  it("returns the personal-workspace public Node route and never sends the session to that Node", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(readyBootstrap()));
    const service = createCloudNodeRoutingService({
      cloudBaseUrl: "https://cloud.alexandria.so",
      legacyMultiplayerBaseUrl: "https://legacy.example",
      fetchImpl,
      now: () => Date.parse("2026-08-28T12:00:00.000Z"),
    });
    const route = await Effect.runPromise(service.resolve(session()));
    expect(route).toMatchObject({
      source: "alexandria_cloud",
      baseUrl: "https://node.acme.example",
      accessToken: "cloud-node-identity",
      workspaceId: "ws_personal_ada",
      workspaceKind: "personal",
      workosOrganizationId: null,
      installationId: "inst_acme",
      entitlements: { inference: true, multiplayer: false, publishing: false, mcp: false },
    });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sealed-session");
    expect((await Effect.runPromise(service.snapshot()))).toMatchObject({
      state: "ready",
      origin: "https://node.acme.example",
      organizationId: null,
      workspaceId: "ws_personal_ada",
    });
  });

  it("rejects a Cloud identity issued for a different Bridge user", async () => {
    const service = createCloudNodeRoutingService({
      cloudBaseUrl: "https://cloud.alexandria.so",
      legacyMultiplayerBaseUrl: null,
      fetchImpl: async () => jsonResponse(readyBootstrap({
        userId: "user_grace",
        workspaceId: "ws_personal_grace",
      })),
      now: () => Date.parse("2026-08-28T12:00:00.000Z"),
    });

    await expect(Effect.runPromise(service.resolve(session())))
      .rejects.toThrow(/does not match the active Bridge user/i);
    expect(await Effect.runPromise(service.snapshot())).toMatchObject({
      state: "authentication_required",
      workspaceId: null,
      installationId: null,
    });
  });

  it("accepts a personal public-Node fallback for an organization session without an assignment", async () => {
    const service = createCloudNodeRoutingService({
      cloudBaseUrl: "https://cloud.alexandria.so",
      legacyMultiplayerBaseUrl: "https://legacy.example",
      fetchImpl: async () => jsonResponse(readyBootstrap()),
      now: () => Date.parse("2026-08-28T12:00:00.000Z"),
    });
    await expect(Effect.runPromise(service.resolve(organizationSession()))).resolves.toMatchObject({
      workspaceKind: "personal",
      workosOrganizationId: null,
      installationId: "inst_acme",
      entitlements: { inference: true, multiplayer: false, publishing: false, mcp: false },
    });
    expect(await Effect.runPromise(service.snapshot())).toMatchObject({
      state: "ready",
      workspaceKind: "personal",
      organizationId: null,
    });
  });

  it("fails closed when Cloud recognizes an assigned organization without a usable Node", async () => {
    const service = createCloudNodeRoutingService({
      cloudBaseUrl: "https://cloud.alexandria.so",
      legacyMultiplayerBaseUrl: "https://legacy.example",
      fetchImpl: async () => jsonResponse({
        version: "alexandria-cloud-bootstrap/1",
        status: "node_not_provisioned",
        workspace: {
          id: "ws_workos_acme",
          kind: "workos_org",
          workosOrganizationId: "org_acme",
          status: "active",
        },
        rotatedSessionToken: null,
      }),
    });
    await expect(Effect.runPromise(service.resolve(organizationSession()))).rejects.toThrow(/not provisioned/i);
    expect((await Effect.runPromise(service.snapshot())).state).toBe("node_not_provisioned");
  });

  it("reports a seat limit as its own state and sends the desktop version", async () => {
    const headers: Headers[] = [];
    const service = createCloudNodeRoutingService({
      cloudBaseUrl: "https://cloud.alexandria.so",
      legacyMultiplayerBaseUrl: null,
      appVersion: "1.2.3",
      platform: "darwin",
      fetchImpl: async (_url, init) => {
        headers.push(new Headers(init?.headers));
        return jsonResponse({
          version: "alexandria-cloud-bootstrap/1",
          status: "seat_limit_reached",
          workspace: { id: "ws_workos_acme", kind: "workos_org", workosOrganizationId: "org_acme", status: "active" },
          rotatedSessionToken: null,
        });
      },
    });
    await expect(Effect.runPromise(service.resolve(organizationSession()))).rejects.toThrow(/no free Ambient seats/);
    expect((await Effect.runPromise(service.snapshot())).state).toBe("seat_limit_reached");
    expect(headers[0]?.get("x-ambient-app-version")).toBe("1.2.3");
    expect(headers[0]?.get("x-ambient-platform")).toBe("darwin");
  });

  it("uses the baked legacy destination only when an old Cloud returns 404", async () => {
    const service = createCloudNodeRoutingService({
      cloudBaseUrl: "https://cloud.alexandria.so",
      legacyMultiplayerBaseUrl: "https://legacy.example/",
      fetchImpl: async () => new Response("not found", { status: 404 }),
    });
    await expect(Effect.runPromise(service.resolve(session()))).resolves.toMatchObject({
      source: "legacy",
      baseUrl: "https://legacy.example",
      accessToken: "sealed-session",
    });
  });

  it("discards an in-flight assignment when the account boundary changes", async () => {
    let answer: ((response: Response) => void) | undefined;
    const service = createCloudNodeRoutingService({
      cloudBaseUrl: "https://cloud.alexandria.so",
      legacyMultiplayerBaseUrl: "https://legacy.example",
      fetchImpl: () => new Promise<Response>((resolve) => { answer = resolve; }),
      now: () => Date.parse("2026-08-28T12:00:00.000Z"),
    });
    const pending = Effect.runPromise(service.resolve(session()));
    await Promise.resolve();
    await Effect.runPromise(service.invalidate());
    answer?.(jsonResponse(readyBootstrap()));
    await expect(pending).rejects.toThrow(/discarded/i);
    expect(await Effect.runPromise(service.snapshot())).toMatchObject({
      state: "unknown",
      organizationId: null,
      origin: null,
    });
  });

  it("keeps the newest session boundary when two assignments finish out of order", async () => {
    let answerFirst!: (response: Response) => void;
    let answerSecond!: (response: Response) => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const service = createCloudNodeRoutingService({
      cloudBaseUrl: "https://cloud.alexandria.so",
      legacyMultiplayerBaseUrl: null,
      fetchImpl: async (_url, init) => {
        const token = new Headers(init?.headers).get("authorization");
        return new Promise<Response>((resolve) => {
          if (token === "Bearer sealed-session-b") {
            answerSecond = resolve;
            markSecondStarted();
          } else {
            answerFirst = resolve;
            markFirstStarted();
          }
        });
      },
      now: () => Date.parse("2026-08-28T12:00:00.000Z"),
    });
    const first = Effect.runPromise(service.resolve(session()));
    await firstStarted;
    const secondSession = {
      ...session(),
      sessionToken: "sealed-session-b",
      email: "grace@acme.example",
      user: { id: "user_grace", email: "grace@acme.example", name: "Grace" },
    } satisfies SignedInWorkOsSession;
    const second = Effect.runPromise(service.resolve(secondSession));
    await secondStarted;

    answerSecond(jsonResponse(readyBootstrap({
      userId: "user_grace",
      workspaceId: "ws_personal_grace",
      installationId: "inst_public_b",
      apiBaseUrl: "https://node-b.acme.example",
    })));
    await expect(second).resolves.toMatchObject({
      workspaceId: "ws_personal_grace",
      installationId: "inst_public_b",
    });
    answerFirst(jsonResponse(readyBootstrap()));
    await expect(first).rejects.toThrow(/discarded/i);
    expect(await Effect.runPromise(service.snapshot())).toMatchObject({
      state: "ready",
      workspaceId: "ws_personal_grace",
      installationId: "inst_public_b",
      origin: "https://node-b.acme.example",
    });
  });

  it("does not cache a route when the account changes during session rotation", async () => {
    let releaseRotation: (() => void) | undefined;
    let rotationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { rotationStarted = resolve; });
    const rotationGate = new Promise<void>((resolve) => { releaseRotation = resolve; });
    const ready = readyBootstrap();
    const body = {
      ...ready,
      identity: { ...ready.identity, rotatedSessionToken: "rotated-sealed-session" },
    };
    const service = createCloudNodeRoutingService({
      cloudBaseUrl: "https://cloud.alexandria.so",
      legacyMultiplayerBaseUrl: "https://legacy.example",
      fetchImpl: async () => jsonResponse(body),
      now: () => Date.parse("2026-08-28T12:00:00.000Z"),
      onRotatedSessionToken: async () => {
        rotationStarted?.();
        await rotationGate;
      },
    });
    const pending = Effect.runPromise(service.resolve(session()));
    await started;
    await Effect.runPromise(service.invalidate());
    releaseRotation?.();
    await expect(pending).rejects.toThrow(/discarded/i);
    expect(await Effect.runPromise(service.snapshot())).toMatchObject({ state: "unknown", origin: null });
  });
});

function session(): SignedInWorkOsSession {
  return {
    kind: "signed_in",
    sessionToken: "sealed-session",
    expiresAt: Math.floor(Date.parse("2026-08-28T13:00:00.000Z") / 1_000),
    organizationId: null,
    organizationName: null,
    email: "ada@acme.example",
    user: { id: "user_ada", email: "ada@acme.example", name: "Ada" },
  };
}

function organizationSession(): SignedInWorkOsSession {
  return { ...session(), organizationId: "org_acme", organizationName: "Acme" };
}

function readyBootstrap(input: {
  readonly userId?: string;
  readonly workspaceId?: string;
  readonly installationId?: string;
  readonly apiBaseUrl?: string;
} = {}) {
  const userId = input.userId ?? "user_ada";
  const workspaceId = input.workspaceId ?? "ws_personal_ada";
  const installationId = input.installationId ?? "inst_acme";
  const apiBaseUrl = input.apiBaseUrl ?? "https://node.acme.example";
  return {
    version: "alexandria-cloud-bootstrap/1",
    status: "ready",
    workspace: {
      id: workspaceId,
      kind: "personal",
      workosOrganizationId: null,
      status: "active",
    },
    node: {
      assignmentId: "assign_default_personal_public",
      installationId,
      apiBaseUrl,
      audience: apiBaseUrl,
      capabilities: ["inference"],
      inferenceMode: "plaintext",
      configurationVersion: 7,
    },
    entitlements: {
      workspaceId,
      inference: true,
      multiplayer: false,
      publishing: false,
      mcp: false,
    },
    billing: {
      workspaceId,
      mode: "user_metered",
      billingAccountId: userId,
      perUserAllowanceMicros: null,
      perUserHardLimitMicros: null,
      overage: "deny",
      pricingVersion: "prices@1",
    },
    identity: {
      tokenType: "Bearer",
      accessToken: "cloud-node-identity",
      expiresAt: "2026-08-28T12:05:00.000Z",
      claims: {
        iss: "https://cloud.alexandria.so",
        aud: apiBaseUrl,
        sub: userId,
        workspaceId,
        workspaceKind: "personal",
        workosOrganizationId: null,
        installationId,
        sessionEpoch: 0,
        entitlements: { inference: true, multiplayer: false, publishing: false, mcp: false },
        billing: {
          mode: "user_metered",
          billingAccountId: userId,
          perUserAllowanceMicros: null,
          perUserHardLimitMicros: null,
          overage: "deny",
          pricingVersion: "prices@1",
        },
        iat: 1787918400,
        exp: 1787918700,
      },
      rotatedSessionToken: null,
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
