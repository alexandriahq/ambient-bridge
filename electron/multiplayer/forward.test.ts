import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryAuditSink } from "../diagnostics/audit.js";
import type { SignedInWorkOsSession } from "../workos/session.js";
import {
  forwardMultiplayerEffectivePolicy,
  forwardMultiplayerEncryption,
  forwardMultiplayerHeartbeat,
  forwardMultiplayerMcp,
  forwardMultiplayerMcpStatus,
  forwardMultiplayerMemory,
  forwardMultiplayerPublish,
  forwardMultiplayerCollection,
  forwardMultiplayerRawCaptureUpload,
  forwardMultiplayerReport,
  forwardMultiplayerTrajectories,
} from "./forward.js";

describe("multiplayer forwarding", () => {
  it("preserves part receipts without treating them as accepted recordings", async () => {
    const uploadPart = { sha256: "a".repeat(64), index: 3 };
    const result = await forwardMultiplayerPublish("req_part", { recordings: [] }, baseOptions(vi.fn(async () => jsonResponse(200, {
      uploadPart, accepted: { memories: 0, chunks: 0, intents: 0, handoffs: 0, recordings: 0 },
    }))));
    expect(result.uploadPart).toEqual(uploadPart);
    expect(result.accepted.recordings).toBe(0);
    await expect(forwardMultiplayerPublish("req_bad", {}, baseOptions(vi.fn(async () => jsonResponse(200, {
      uploadPart: { sha256: "bad", index: -1 }, accepted: {},
    }))))).rejects.toThrow("upload part");
  });
  it("rejects publish when Bridge is signed out", async () => {
    await expect(forwardMultiplayerPublish("req_1", { memories: [] }, {
      audit: new MemoryAuditSink(),
      fetchImpl: vi.fn(),
      multiplayerBaseUrl: "https://multiplayer.example",
      onUnauthorized: vi.fn(),
      readSession: async () => ({ kind: "signed_out" }),
      refreshSession: vi.fn(),
    })).rejects.toThrow(/Sign in to Ambient Bridge/);
  });

  it("sends the WorkOS session to /v1/me and stamps no API key", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/me/encryption")) {
        return jsonResponse(200, {
          orgId: "org_wo_1",
          profile: "customer_kms",
          required: true,
          kmsProvider: "azure_key_vault",
          kmsKeyId: "https://acme.vault.azure.net/keys/multiplayer/1",
        });
      }
      if (url.endsWith("/v1/me/effective-policy")) {
        return jsonResponse(200, {
          orgId: "org_wo_1",
          userId: "usr_wo_1",
          effective: { userId: "usr_wo_1", layers: { control: "auto_share" }, appliedPolicyIds: [] },
        });
      }
      if (url.endsWith("/v1/me/publish")) {
        return jsonResponse(200, {
          accepted: { memories: 1, chunks: 0, intents: 0, handoffs: 0, recordings: 0 },
        });
      }
      return jsonResponse(404, { error: "not found" });
    });

    const encryption = await forwardMultiplayerEncryption("req_enc", baseOptions(fetchImpl));
    expect(encryption).toMatchObject({
      orgId: "org_wo_1",
      profile: "customer_kms",
      kmsProvider: "azure_key_vault",
    });

    const policy = await forwardMultiplayerEffectivePolicy("req_1", baseOptions(fetchImpl));
    expect(policy).toMatchObject({ orgId: "org_wo_1", userId: "usr_wo_1", control: "auto_share", companyProfile: null });

    const published = await forwardMultiplayerPublish("req_2", {
      memories: [{ id: "m1", userId: "local", occurredAt: "2026-01-01T00:00:00.000Z", title: "T", content: "C", sourceApp: null, tags: [] }],
    }, baseOptions(fetchImpl));
    expect(published.accepted.memories).toBe(1);

    const urls = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      "https://multiplayer.example/v1/me/encryption",
      "https://multiplayer.example/v1/me/effective-policy",
      "https://multiplayer.example/v1/me/publish",
    ]);
    const publishInit = fetchImpl.mock.calls[2]?.[1] as RequestInit;
    const headers = publishInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer session-token-1");
    expect(headers["x-multiplayer-workos-organization-name"]).toBe("Acme AG");
    expect(JSON.stringify(headers)).not.toContain("multiplayer-dev-token");
  });

  it("uses the Cloud-selected Node and never forwards the WorkOS session", async () => {
    const onResponse = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      accepted: { memories: 1, chunks: 0, intents: 0, handoffs: 0, recordings: 0 },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ambient-session-token": "node-injected-workos-session",
      },
    }));
    await forwardMultiplayerPublish("req_cloud", { memories: [] }, {
      ...baseOptions(fetchImpl),
      onResponse,
      resolveRoute: vi.fn(async () => ({
        source: "alexandria_cloud" as const,
        baseUrl: "https://node.acme.example",
        accessToken: "cloud-node-identity",
        capabilities: ["multiplayer", "publishing", "mcp"] as const,
        entitlements: { inference: false, multiplayer: true, publishing: true, mcp: true },
      })),
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://node.acme.example/v1/me/publish");
    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cloud-node-identity");
    expect(JSON.stringify(headers)).not.toContain("session-token-1");
    expect(onResponse).not.toHaveBeenCalled();
  });

  it("does not call a Cloud-selected Node without the Multiplayer capability", async () => {
    const fetchImpl = vi.fn();
    await expect(forwardMultiplayerHeartbeat("req_cloud_core", {
      ...baseOptions(fetchImpl),
      resolveRoute: async () => ({
        source: "alexandria_cloud",
        baseUrl: "https://node.acme.example",
        accessToken: "cloud-node-identity",
        capabilities: ["inference"],
        entitlements: { inference: true, multiplayer: false, publishing: false, mcp: false },
      }),
    })).rejects.toThrow(/Multiplayer is not enabled/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not let Multiplayer entitlement implicitly authorize publishing", async () => {
    const fetchImpl = vi.fn();
    await expect(forwardMultiplayerPublish("req_cloud_publish_denied", { memories: [] }, {
      ...baseOptions(fetchImpl),
      resolveRoute: async () => ({
        source: "alexandria_cloud",
        baseUrl: "https://node.acme.example",
        accessToken: "cloud-node-identity",
        capabilities: ["multiplayer", "publishing"],
        entitlements: { inference: false, multiplayer: true, publishing: false, mcp: false },
      }),
    })).rejects.toThrow(/Publishing is not enabled/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not let Multiplayer entitlement implicitly authorize MCP reads", async () => {
    const fetchImpl = vi.fn();
    await expect(forwardMultiplayerMemory("req_cloud_mcp_denied", { query: "forecast" }, {
      ...baseOptions(fetchImpl),
      resolveRoute: async () => ({
        source: "alexandria_cloud",
        baseUrl: "https://node.acme.example",
        accessToken: "cloud-node-identity",
        capabilities: ["multiplayer", "mcp"],
        entitlements: { inference: false, multiplayer: true, publishing: false, mcp: false },
      }),
    })).rejects.toThrow(/MCP is not enabled/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("invalidates only the Node identity when a Cloud-selected Node returns 401", async () => {
    const onNodeUnauthorized = vi.fn(async () => undefined);
    await expect(forwardMultiplayerHeartbeat("req_node_401", {
      ...baseOptions(async () => jsonResponse(401, { error: "unauthorized" })),
      resolveRoute: async () => ({
        source: "alexandria_cloud",
        baseUrl: "https://node.acme.example",
        accessToken: "expired-node-identity",
        capabilities: ["multiplayer"],
        entitlements: { inference: false, multiplayer: true, publishing: true, mcp: false },
      }),
      onNodeUnauthorized,
    })).rejects.toThrow(/401/);
    expect(onNodeUnauthorized).toHaveBeenCalledOnce();
  });

  it("heartbeats /v1/me without publishing", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/me/heartbeat")) {
        return jsonResponse(200, { instance: { id: "desk-1" } });
      }
      return jsonResponse(404, { error: "not found" });
    });

    const beat = await forwardMultiplayerHeartbeat("req_hb", baseOptions(fetchImpl));
    expect(beat.instanceId).toBe("desk-1");
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://multiplayer.example/v1/me/heartbeat",
    ]);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { instance: { lastPublishAt?: string; status: string } };
    expect(body.instance.status).toBe("online");
    expect(body.instance.lastPublishAt).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer session-token-1");
  });

  it("forwards org memory reads to GET /v1/me/memory with the WorkOS session", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/me/memory")) {
        return jsonResponse(200, { memories: [{ id: "mem_1", title: "Shared forecast" }] });
      }
      return jsonResponse(404, { error: "not found" });
    });

    const payload = await forwardMultiplayerMemory("req_mem", {
      query: "forecast",
      limit: 5,
    }, baseOptions(fetchImpl));
    expect(payload.memories).toEqual([{ id: "mem_1", title: "Shared forecast" }]);
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://multiplayer.example/v1/me/memory?query=forecast&limit=5",
    ]);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer session-token-1");
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain("multiplayer-dev-token");
  });

  it("maps leftover MCP tool names onto the REST consume paths", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/me/trajectories")) {
        return jsonResponse(200, { trajectories: [{ intent: { id: "int_1" } }] });
      }
      return jsonResponse(404, { error: "not found" });
    });

    const payload = await forwardMultiplayerMcp("req_mcp", {
      name: "list_org_trajectories",
      arguments: { limit: 3 },
    }, baseOptions(fetchImpl));
    expect(payload).toEqual({ trajectories: [{ intent: { id: "int_1" } }] });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://multiplayer.example/v1/me/trajectories?limit=3",
    );
  });

  it("forwards org trajectories to GET /v1/me/trajectories", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { trajectories: [] }));
    await forwardMultiplayerTrajectories("req_tr", { limit: 2 }, baseOptions(fetchImpl));
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://multiplayer.example/v1/me/trajectories?limit=2",
    );
  });

  it("reports MCP status without probing when Multiplayer is unconfigured", async () => {
    const fetchImpl = vi.fn();
    const status = await forwardMultiplayerMcpStatus("req_mcp_off", {
      ...baseOptions(fetchImpl),
      multiplayerBaseUrl: null,
    });
    expect(status).toMatchObject({
      configured: false,
      origin: null,
      signedIn: false,
      state: "unconfigured",
      lastError: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports MCP signed_out without calling Multiplayer", async () => {
    const fetchImpl = vi.fn();
    const status = await forwardMultiplayerMcpStatus("req_mcp_out", {
      ...baseOptions(fetchImpl),
      readSession: async () => ({ kind: "signed_out" }),
    });
    expect(status).toMatchObject({
      configured: true,
      origin: "https://multiplayer.example",
      signedIn: false,
      state: "signed_out",
      lastError: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("probes GET /v1/me/effective-policy and reports reachable", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/me/effective-policy")) {
        return jsonResponse(200, {
          orgId: "org_wo_1",
          userId: "usr_wo_1",
          effective: { userId: "usr_wo_1", layers: { control: "auto_share" }, appliedPolicyIds: [] },
        });
      }
      return jsonResponse(404, { error: "not found" });
    });

    const status = await forwardMultiplayerMcpStatus("req_mcp_ok", baseOptions(fetchImpl));
    expect(status).toMatchObject({
      configured: true,
      origin: "https://multiplayer.example",
      signedIn: true,
      state: "reachable",
      lastError: null,
    });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer session-token-1");
  });

  it("maps a not-provisioned policy probe to not_provisioned", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, {
      error: "not_provisioned",
      message: "Your IT admin has to add you in Multiplayer before you can sign in or share.",
    }));
    const status = await forwardMultiplayerMcpStatus("req_mcp_gate", baseOptions(fetchImpl));
    expect(status).toMatchObject({
      configured: true,
      signedIn: true,
      state: "not_provisioned",
      lastError: "Your IT admin has to add you in Multiplayer before you can share.",
    });
  });

  it("maps a Cloud assignment provisioning gate without leaking the legacy origin", async () => {
    const status = await forwardMultiplayerMcpStatus("req_cloud_gate", {
      ...baseOptions(vi.fn()),
      resolveRoute: async () => { throw new Error("Alexandria Node is not provisioned for this organization."); },
    });
    expect(status).toMatchObject({
      configured: true,
      origin: null,
      signedIn: true,
      state: "not_provisioned",
    });
  });

  it("maps a Railway 404 policy probe to unreachable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, {
      status: "error",
      code: 404,
      message: "Application not found",
    }));
    const status = await forwardMultiplayerMcpStatus("req_mcp_404", baseOptions(fetchImpl));
    expect(status).toMatchObject({
      configured: true,
      signedIn: true,
      state: "unreachable",
      lastError: "Multiplayer ingest is not reachable at this origin.",
    });
  });

  it("maps an unreachable MCP probe to unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const status = await forwardMultiplayerMcpStatus("req_mcp_down", baseOptions(fetchImpl));
    expect(status.state).toBe("unreachable");
    expect(status.signedIn).toBe(true);
    expect(status.lastError).toMatch(/unreachable/i);
  });

  it("probes MCP status without refreshing the WorkOS session", async () => {
    const refreshSession = vi.fn(async () => {
      throw new Error("health probes must not refresh");
    });
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      orgId: "org_wo_1",
      userId: "usr_wo_1",
      effective: { userId: "usr_wo_1", layers: {}, appliedPolicyIds: [] },
    }));
    const expiring = session();
    expiring.expiresAt = Math.floor(Date.now() / 1000) - 10;

    const status = await forwardMultiplayerMcpStatus("req_mcp_norefresh", {
      ...baseOptions(fetchImpl),
      readSession: async () => expiring,
      refreshSession,
    });
    expect(status.state).toBe("reachable");
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("does not treat a Multiplayer 401 as a WorkOS session expiry", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "unauthorized" }));

    await expect(forwardMultiplayerHeartbeat("req_401", {
      ...baseOptions(fetchImpl),
      onUnauthorized,
    })).rejects.toThrow(/401/);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

function baseOptions(fetchImpl: typeof fetch) {
  return {
    audit: new MemoryAuditSink(),
    fetchImpl,
    multiplayerBaseUrl: "https://multiplayer.example",
    onUnauthorized: vi.fn(),
    readSession: async () => session(),
    refreshSession: vi.fn(),
    instanceId: "desk-1",
    appVersion: "0.0.0-test",
  };
}

function session(): SignedInWorkOsSession {
  return {
    kind: "signed_in",
    sessionToken: "session-token-1",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "user_1", email: "ada@acme.example", name: "Ada" },
    email: "ada@acme.example",
    organizationId: "org_1",
    organizationName: "Acme AG",
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}


describe("reviewed report forwarding", () => {
  it.each(["status", "withdraw", "get-destinations"])("allows owner %s after publishing is revoked", async (operation) => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { publicationId: "report", withdrawn: true, teamspaceIds: [] }));
    await forwardMultiplayerReport("recovery", { operation, publicationId: "report", expectedTeamspaceIds: [] }, {
      ...baseOptions(fetchImpl), resolveRoute: async () => ({ source: "alexandria_cloud", baseUrl: "https://node.example", accessToken: "node-token",
        capabilities: ["multiplayer"], entitlements: { inference: false, multiplayer: true, publishing: false, mcp: false } }),
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`https://node.example/v1/me/reports/report/${operation === "get-destinations" ? "destinations" : operation}`);
  });
  it("allows owner recovery with Multiplayer access after publishing is revoked", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { state: "cancelled" }));
    await forwardMultiplayerReport("recover", { operation: "reconcile", publication: { version: "ambient-report-publication/1" }, teamspaceIds: [] }, {
      ...baseOptions(fetchImpl), resolveRoute: async () => ({ source: "alexandria_cloud", baseUrl: "https://node.example", accessToken: "node-token",
        capabilities: ["multiplayer"], entitlements: { inference: false, multiplayer: true, publishing: false, mcp: false } }),
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://node.example/v1/me/reports/reconcile");
  });
  it("forwards only closed Node routes and session identity", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { state: "staged" }));
    await forwardMultiplayerReport("req_report", { operation: "prepare", publication: { version: "ambient-report-publication/1" }, teamspaceIds: ["company"] }, baseOptions(fetchImpl));
    const [url, request] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://multiplayer.example/v1/me/reports/prepare");
    expect(request.headers).toMatchObject({ Authorization: "Bearer session-token-1" });
    expect(JSON.parse(String(request.body))).toEqual({ publication: { version: "ambient-report-publication/1" }, teamspaceIds: ["company"] });
    await expect(forwardMultiplayerReport("req_invalid", { operation: "https://other.test" }, baseOptions(fetchImpl))).rejects.toThrow("Unknown report operation");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("forwards a full bounded part as binary without including bytes in audit", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const options = baseOptions(fetchImpl);
    const record = vi.spyOn(options.audit, "record");
    const bytes = Buffer.alloc(1024 * 1024, 42);
    await forwardMultiplayerReport("req_part", { operation: "part", publicationId: "report/id", assetId: "asset", part: 0, base64: bytes.toString("base64") }, options);
    const [url, request] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://multiplayer.example/v1/me/reports/report%2Fid/assets/asset/parts/0");
    expect(request.method).toBe("PUT");
    expect(request.headers).toMatchObject({ "Content-Type": "application/octet-stream" });
    expect(Buffer.from(request.body as ArrayBuffer)).toEqual(bytes);
    expect(JSON.stringify(record.mock.calls)).not.toContain(bytes.toString("base64"));
  });
  it("rejects malformed parts and denied publishing before network access", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    for (const base64 of ["bad!", "a===", "YQ=", "", Buffer.alloc(1024 * 1024 + 1).toString("base64")]) {
      await expect(forwardMultiplayerReport("bad", { operation: "part", publicationId: "report", assetId: "asset", part: 0, base64 }, baseOptions(fetchImpl))).rejects.toThrow("Invalid report upload part");
    }
    await expect(forwardMultiplayerReport("denied", { operation: "commit", publicationId: "report" }, {
      ...baseOptions(fetchImpl), resolveRoute: async () => ({ source: "alexandria_cloud", baseUrl: "https://node.example", accessToken: "node-token",
        capabilities: ["multiplayer", "publishing"], entitlements: { inference: false, multiplayer: true, publishing: false, mcp: false } }),
    })).rejects.toThrow("not enabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("raw capture forwarding", () => {
  const bytes = new TextEncoder().encode("frame bytes");
  const manifest = { version: "ambient-raw-capture/1", segmentId: "seg_0001_screen", deviceId: "dev", source: "screen",
    startedAt: "2026-09-26T10:00:00Z", endedAt: "2026-09-26T10:00:00Z", contentType: "image/jpeg", byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"), metadata: {} };

  it("sends raw bytes with the manifest header and the segment's content type", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { segmentId: manifest.segmentId, duplicate: false }));
    const receipt = await forwardMultiplayerRawCaptureUpload("raw", { manifest }, bytes, baseOptions(fetchImpl));
    expect(receipt).toMatchObject({ segmentId: manifest.segmentId });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://multiplayer.example/v1/me/raw-capture/segments/seg_0001_screen");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("PUT");
    expect(headers["Content-Type"]).toBe("image/jpeg");
    expect(JSON.parse(Buffer.from(headers["x-ambient-raw-capture-manifest"]!, "base64url").toString())).toEqual(manifest);
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(bytes);
  });

  it("forwards pointer-action JSON and its source without changing bytes", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, { duplicate: false }));
    const mouse = new TextEncoder().encode('{"schema_version":1,"actions":[{"kind":"click"},{"kind":"scroll"}]}');
    const mouseManifest = { ...manifest, source: "pointer_actions", contentType: "application/json", byteLength: mouse.byteLength, sha256: createHash("sha256").update(mouse).digest("hex") };
    await forwardMultiplayerRawCaptureUpload("mouse", { manifest: mouseManifest }, mouse, baseOptions(fetchImpl));
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(mouse);
    expect(JSON.parse(Buffer.from((init.headers as Record<string, string>)["x-ambient-raw-capture-manifest"]!, "base64url").toString()).source).toBe("pointer_actions");
  });

  it("refuses bytes that do not match the manifest before any network call", async () => {
    const fetchImpl = vi.fn();
    await expect(forwardMultiplayerRawCaptureUpload("raw", { manifest: { ...manifest, sha256: "0".repeat(64) } }, bytes, baseOptions(fetchImpl)))
      .rejects.toThrow("do not match");
    await expect(forwardMultiplayerRawCaptureUpload("raw", { manifest: { ...manifest, contentType: "text/html" } }, bytes, baseOptions(fetchImpl)))
      .rejects.toThrow("Invalid raw capture manifest");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});


it("collection rejects an outbox from another account before sending any bytes", async () => {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, { accepted: [] }));
  await expect(forwardMultiplayerCollection("collection-wrong-owner", { expectedWorkosOrganizationId: "org_2", expectedWorkosUserId: "user_1", records: [] }, baseOptions(fetchImpl))).rejects.toThrow("account changed");
  expect(fetchImpl).not.toHaveBeenCalled();
  await forwardMultiplayerCollection("collection-owner", { expectedWorkosOrganizationId: "org_1", expectedWorkosUserId: "user_1", records: [] }, baseOptions(fetchImpl));
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ records: [] });
});
