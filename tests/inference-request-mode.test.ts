import * as audio from "../electron/inference/audio-transcription.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import * as inference from "../electron/inference/effect.js";
import * as routing from "../electron/cloud/node-assignment.js";
import * as requestMode from "../electron/inference/request-mode.js";
import * as registry from "../electron/inference/request-registry.js";
import * as network from "../electron/inference/network-log.js";
import * as availability from "../electron/inference/availability.js";
import * as errors from "../electron/inference/errors.js";
import * as sessionModule from "../electron/workos/session.js";
import * as auditModule from "../electron/diagnostics/audit.js";
import * as ownedStream from "../electron/inference/owned-stream.js";
import * as streaming from "../electron/proxy/streaming.js";
import * as messages from "../electron/error-message.js";
import type { BridgeRequestFrame, JsonValue } from "../electron/ipc-server/protocol.js";
import type { IpcStream } from "../electron/ipc-server/socket.js";
import type { SignedInWorkOsSession } from "../electron/workos/session.js";
import { AMBIENT_BRIDGE_CAPABILITIES } from "@ambient/shared/product-version";
import { createMainInferenceHarness } from "./helpers/main-inference.js";

// Every Cloud and Node call goes to an in-memory fixture; a default network path fails.
const originalFetch = vi.hoisted(() => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Uncontrolled inference fixture fetch"); };
  return original;
});
afterAll(() => { globalThis.fetch = originalFetch; });
const forbid = (name: string) => (..._args: unknown[]): never => { throw new Error(`Forbidden fixture operation: ${name}`); };

type NodeMode = "confidential" | "plaintext";
type Call = { readonly client: "tinfoil" | "plaintext"; readonly path: string; readonly mode: string | null; readonly body: unknown };

const SESSION: SignedInWorkOsSession = {
  kind: "signed_in", sessionToken: "synthetic-workos", email: "ada@fixture.invalid",
  expiresAt: Math.floor(Date.now() / 1000) + 86400,
  user: { id: "user_ada", email: "ada@fixture.invalid", name: null },
};
const NODE = "https://node.fixture.invalid";

function bootstrap(inferenceMode: NodeMode) {
  const nowSeconds = Math.floor(Date.now() / 1000), expiry = nowSeconds + 3600;
  const entitlements = { inference: true, multiplayer: false, publishing: false, mcp: false };
  const billing = { mode: "user_metered", billingAccountId: "user_ada", perUserAllowanceMicros: null,
    perUserHardLimitMicros: null, overage: "deny", pricingVersion: "fixture-prices@1" };
  return { version: "alexandria-cloud-bootstrap/1", status: "ready",
    workspace: { id: "workspace_ada", kind: "personal", workosOrganizationId: null, status: "active" },
    node: { assignmentId: "assignment_ada", installationId: "installation_ada", apiBaseUrl: NODE, audience: NODE,
      capabilities: ["inference"], inferenceMode, configurationVersion: 7 },
    entitlements: { workspaceId: "workspace_ada", ...entitlements }, billing: { workspaceId: "workspace_ada", ...billing },
    identity: { tokenType: "Bearer", accessToken: "synthetic-node-identity",
      expiresAt: new Date(expiry * 1000).toISOString(), rotatedSessionToken: null,
      claims: { iss: "https://cloud.fixture.invalid", aud: NODE, sub: "user_ada", workspaceId: "workspace_ada",
        workspaceKind: "personal", workosOrganizationId: null, installationId: "installation_ada", sessionEpoch: 0,
        entitlements, billing, iat: nowSeconds, exp: expiry } } };
}

async function bodyOf(init: RequestInit): Promise<unknown> {
  if (typeof init.body === "string") return JSON.parse(init.body) as unknown;
  if (init.body instanceof FormData) return Object.fromEntries([...init.body.keys()].map((key) => [key, String(init.body instanceof FormData ? init.body.get(key) : "")]));
  return null;
}

function fixture(nodeMode: NodeMode, options: { readonly tinfoilFails?: boolean } = {}) {
  const calls: Call[] = [];
  const audit = new auditModule.MemoryAuditSink();
  const cloudNodeRouting = routing.createCloudNodeRoutingService({
    cloudBaseUrl: "https://cloud.fixture.invalid", legacyMultiplayerBaseUrl: null,
    fetchImpl: async () => Response.json(bootstrap(nodeMode)),
    onRotatedSessionToken: forbid("Cloud token rotation"),
  });
  const ok = () => new Response("data: ok\n\n", { headers: { "content-type": "text/event-stream" } });
  const clearOnly = () => ({ clear: () => undefined, observe: forbid("observe") });
  const sentinelClient = { ready: forbid("legacy ready"), fetch: forbid("legacy fetch") };
  const runtime = createMainInferenceHarness({
    Effect, ...audio, ...inference, ...routing, ...requestMode, ...registry, ...network, ...errors, ...ownedStream, ...streaming, ...messages,
    shouldRefreshWorkOsSession: sessionModule.shouldRefreshWorkOsSession,
    activeInferenceRequests: new registry.InferenceRequestRegistry(),
    networkHistory: new network.NetworkRequestHistory(),
    inferenceAvailability: new availability.InferenceAvailabilityCircuit(),
    sessionUsageOwnerKey: availability.sessionUsageOwnerKey,
    inferenceAccessBlockReason: availability.inferenceAccessBlockReason,
    cloudNodeRouting,
    createBridgeSecureClient: (input: { serverBaseUrl: string }) => inference.createBridgeSecureClient({ ...input,
      makeSecureClient: (secure) => {
        expect(secure.baseURL).toBe(NODE);
        expect(secure.attestationBundleURL).toBe(NODE);
        return { ready: async () => undefined, fetch: async (path, init) => {
          const headers = new Headers(init?.headers);
          calls.push({ client: "tinfoil", path: String(path), mode: headers.get("x-alexandria-inference-mode"), body: await bodyOf(init ?? {}) });
          if (options.tinfoilFails) throw new TypeError("synthetic enclave failure");
          return ok();
        } };
      } }),
    createBridgePlaintextClient: (input: { serverBaseUrl: string }) => inference.createBridgePlaintextClient({ ...input,
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({ client: "plaintext", path: String(url).replace(NODE, ""), mode: headers.get("x-alexandria-inference-mode"), body: await bodyOf(init ?? {}) });
        return ok();
      } }),
    bridgeSecureClient: sentinelClient,
    sessionStore: () => ({ read: async () => structuredClone(SESSION), write: forbid("session write"), clear: forbid("session clear") }),
    refreshStoredSessionDirect: forbid("WorkOS refresh"), storeRotatedSessionToken: forbid("response token rotation"),
    bridgeUsageService: { reserve: forbid("legacy reserve"), release: forbid("legacy release") },
    bridgeUsageCache: clearOnly(), bridgeModelAssignmentCache: clearOnly(), bridgeInferencePlanCache: clearOnly(), bridgeOrgPolicyCache: clearOnly(),
    bridgePricingCache: clearOnly(), wireTap: clearOnly(),
    audit, bridgeAuditService: inference.createBridgeAuditService(audit),
    publishRequestLogUpserts: () => undefined, publishRequestLogReset: () => undefined, notifyStatusChanged: () => undefined,
    refreshInferenceUsageCircuit: async () => undefined,
    app: { getVersion: () => "fixture-only", isPackaged: true },
    serverBaseUrl: "https://cloud.fixture.invalid",
    console: { error: () => undefined },
  });
  const context = (upload?: Buffer) => ({
    credentialId: "fixture-client",
    readBinaryUpload: upload ? async () => upload : forbid("binary upload"),
  });
  const frame = (method: string, payload: JsonValue): BridgeRequestFrame => ({ type: "request", id: `request-${calls.length}-${method}`, method, payload });
  return {
    calls,
    audit,
    json: (method: string, path: inference.InferenceProxyPath, payload: JsonValue) =>
      drain(runtime.forwardInference(frame(method, payload), context(), path)),
    audio: (payload: Record<string, JsonValue>, bytes: Buffer) =>
      drain(runtime.forwardAudioTranscription(frame("inference.audioTranscriptions", payload), context(bytes))),
    start: (method: string, path: inference.InferenceProxyPath, payload: JsonValue) => runtime.forwardInference(frame(method, payload), context(), path),
  };
}

async function drain(stream: IpcStream): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("Bridge per-request inference transport (ADR-0313)", () => {
  it("advertises the inference.mode capability in bridge.health", () => {
    const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
    expect(AMBIENT_BRIDGE_CAPABILITIES.inferenceMode).toBe("inference.mode");
    expect(main).toMatch(/"bridge\.health": async \(\) => \(\{[\s\S]{0,200}capabilities: \[AMBIENT_BRIDGE_CAPABILITIES\.inferenceMode\]/);
  });

  it("runs a request without a mode in the Node's assigned mode, as released apps send", async () => {
    const plaintext = fixture("plaintext");
    await plaintext.json("inference.chatCompletions", "/v1/chat/completions", { model: "gemma-4-31b", messages: [] });
    expect(plaintext.calls).toEqual([{ client: "plaintext", path: "/v1/chat/completions", mode: "plaintext", body: { model: "gemma-4-31b", messages: [] } }]);

    const confidential = fixture("confidential");
    await confidential.json("inference.responses", "/v1/responses", { model: "gemma-4-31b", input: "hi" });
    expect(confidential.calls.map(({ client, mode }) => ({ client, mode }))).toEqual([{ client: "tinfoil", mode: "confidential" }]);
  });

  it("sends a Confidential request through Tinfoil on a plaintext-default Node and strips the field", async () => {
    const f = fixture("plaintext");
    const chunks = await f.json("inference.responses", "/v1/responses", { model: "gemma-4-31b", input: "hi", inferenceMode: "confidential" });
    expect(chunks[0]).toMatchObject({ kind: "openai.response.start", status: 200 });
    expect(f.calls).toEqual([{ client: "tinfoil", path: "/v1/responses", mode: "confidential", body: { model: "gemma-4-31b", input: "hi" } }]);
    expect(f.audit.recent().find((event) => event.name === "inference.forward_start")?.fields).toMatchObject({ requestedMode: "confidential" });
  });

  it("sends a Zero Data Retention request in plaintext on a confidential-default Node", async () => {
    const f = fixture("confidential");
    await f.json("inference.dailyReport", "/v1/responses", { model: "glm-5", input: "day", inferenceMode: "zero-retention" });
    expect(f.calls).toEqual([{ client: "plaintext", path: "/v1/responses", mode: "plaintext", body: { model: "glm-5", input: "day" } }]);
  });

  it("selects the transport per request, not per Node", async () => {
    const f = fixture("plaintext");
    await f.json("inference.chatCompletions", "/v1/chat/completions", { model: "a", inferenceMode: "confidential" });
    await f.json("inference.chatCompletions", "/v1/chat/completions", { model: "b", inferenceMode: "zero-retention" });
    await f.json("inference.chatCompletions", "/v1/chat/completions", { model: "c" });
    expect(f.calls.map(({ client, mode }) => `${client}:${mode}`)).toEqual(["tinfoil:confidential", "plaintext:plaintext", "plaintext:plaintext"]);
  });

  it("refuses embeddings in Confidential and runs them in Zero Data Retention", async () => {
    const confidential = fixture("plaintext");
    await expect(confidential.json("inference.embeddings", "/v1/embeddings", { model: "baai/bge-m3", input: "x", inferenceMode: "confidential" }))
      .rejects.toThrow(/only in Alexandria Zero Data Retention/);
    expect(confidential.calls).toEqual([]);

    const assignedConfidential = fixture("confidential");
    await expect(assignedConfidential.json("inference.embeddings", "/v1/embeddings", { model: "baai/bge-m3", input: "x" }))
      .rejects.toThrow(/only in Alexandria Zero Data Retention/);
    expect(assignedConfidential.calls).toEqual([]);

    const zeroRetention = fixture("confidential");
    await zeroRetention.json("inference.embeddings", "/v1/embeddings", { model: "baai/bge-m3", input: "x", inferenceMode: "zero-retention" });
    expect(zeroRetention.calls).toEqual([{ client: "plaintext", path: "/v1/embeddings", mode: "plaintext", body: { model: "baai/bge-m3", input: "x" } }]);
  });

  it("refuses an unknown mode before admitting the request", async () => {
    const f = fixture("plaintext");
    expect(() => f.start("inference.responses", "/v1/responses", { model: "m", inferenceMode: "plaintext" }))
      .toThrow(requestMode.InferenceModeRequestError);
    expect(f.calls).toEqual([]);
  });

  it("never retries a failed Confidential request as plaintext", async () => {
    const f = fixture("plaintext", { tinfoilFails: true });
    await expect(f.json("inference.responses", "/v1/responses", { model: "m", input: "hi", inferenceMode: "confidential" }))
      .rejects.toThrow(/synthetic enclave failure/);
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls.every((call) => call.client === "tinfoil" && call.mode === "confidential")).toBe(true);
  });

  it("carries the mode on audio transcriptions without forwarding it in the form", async () => {
    const bytes = Buffer.from("RIFF-synthetic-audio");
    const { createHash } = await import("node:crypto");
    const f = fixture("plaintext");
    await f.audio({
      model: "whisper-large-v3",
      audioByteLength: bytes.byteLength,
      audioSha256: createHash("sha256").update(bytes).digest("hex"),
      inferenceMode: "confidential",
    }, bytes);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ client: "tinfoil", path: "/v1/audio/transcriptions", mode: "confidential" });
    expect(Object.keys(f.calls[0]!.body as Record<string, string>)).not.toContain("inferenceMode");
    expect((f.calls[0]!.body as Record<string, string>).model).toBe("whisper-large-v3");
  });
});
