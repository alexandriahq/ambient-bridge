// Fake `window.ambientBridge` for the browser / Claude preview, where the
// Electron preload that normally provides it does not exist. Without this the
// bridge renderer only ever shows its hardcoded "starting / signed-out" fallback.
//
// Opt-in via VITE_AMBIENT_MOCK=1 (set on the browser dev server — see the
// `bridge-renderer-mock` config in .claude/launch.json). Installed from main.ts
// before the app mounts; never clobbers a real preload.

import type {
  BridgeFeatureFlags,
  BridgeInferenceRequestStatus,
  BridgePairedClient,
  BridgeRequestLogPatch,
  BridgeStatus,
  BridgeUiApi,
  BridgeUpdateStatus,
  BridgeWireCapture,
} from "../bridge-api";
import {
  bridgeMockClientLabel,
  resolveBridgeMockPlatform,
} from "./platform";

const NOW = Date.now();
const MIN = 60_000;
const mockUpdateState = typeof window === "undefined"
  ? null
  : new URLSearchParams(window.location.search).get("bridgeMockUpdate");
const mockPlaintextInference = typeof window !== "undefined"
  && new URLSearchParams(window.location.search).get("bridgeMockPlaintext") === "1";
const mockPlaintextInferenceWarningHidden = typeof window !== "undefined"
  && new URLSearchParams(window.location.search).get("bridgeMockPlaintextWarningHidden") === "1";

const featureFlags: BridgeFeatureFlags = {
  enabledSlugs: [
    ...(typeof window !== "undefined" && new URLSearchParams(window.location.search).get("bridgeMockModelDetails") === "1" ? ["show-model-details"] : []),
    "integrations-enabled",
    "automations-enabled",
    "devtools-visible",
    "enable-agents",
    "enable-skills",
    "enable-reports",
  ],
  definitions: [],
  capabilities: {
    integrations: true,
    automations: true,
    automationToggleTrack: true,
    devtooling: true,
    contextHandoff: true,
    skills: true, reports: true,
  },
  evaluatedFor: { userId: "user-mock", organizationId: "org-mock" },
  sample: { slug: "integrations-enabled", enabled: true },
  source: "organization",
};

const inferenceRequests: BridgeInferenceRequestStatus[] = [
  {
    completedAt: NOW - 2 * MIN,
    feature: "chunk-analysis",
    model: "gemma4-31b",
    path: "/v1/chat/completions",
    requestId: "req-1",
    startedAt: NOW - 2 * MIN - 1_400,
    status: "completed",
    statusCode: 200,
    requestBytes: 8_231,
    encryption: "ehbp",
    attestation: "verified",
    ehbpResponseNonce: "nonce-1",
    tinfoilRequestId: "tf-1",
    usage: { promptTokens: 4210, completionTokens: 318, totalTokens: 4528 },
    error: null,
    wireCaptured: true,
    traceId: "0123456789abcdef0123456789abcdef",
    responseHeadersAt: NOW - 2 * MIN - 1_000,
    firstChunkAt: NOW - 2 * MIN - 800,
  },
  {
    completedAt: null,
    feature: "intent-loop",
    model: "glm-5-2",
    path: "/v1/responses",
    requestId: "req-2",
    startedAt: NOW - 3_000,
    status: "active",
    statusCode: null,
    requestBytes: 5_120,
    encryption: "ehbp",
    attestation: "pending",
    ehbpResponseNonce: null,
    tinfoilRequestId: null,
    usage: null,
    error: null,
    wireCaptured: false,
    traceId: "1123456789abcdef0123456789abcdef",
    responseHeadersAt: NOW - 2_000,
    firstChunkAt: null,
  },
  {
    completedAt: NOW - 20 * MIN,
    feature: "transcription",
    model: "whisper-large-v3-turbo",
    path: "/v1/audio/transcriptions",
    requestId: "req-3",
    startedAt: NOW - 20 * MIN - 900,
    status: "failed",
    statusCode: 503,
    requestBytes: 240_112,
    encryption: "ehbp",
    attestation: "failed",
    ehbpResponseNonce: null,
    tinfoilRequestId: null,
    usage: null,
    error: "Upstream enclave unavailable (503)",
    wireCaptured: true,
    traceId: "2123456789abcdef0123456789abcdef",
    responseHeadersAt: NOW - 20 * MIN - 200,
    firstChunkAt: null,
  },
  {
    completedAt: NOW - 4 * MIN,
    feature: "intent-loop",
    model: "deepseek-v4-flash",
    path: "/v1/chat/completions",
    requestId: "req-4",
    startedAt: NOW - 4 * MIN - 1_100,
    status: "completed",
    statusCode: 200,
    requestBytes: 3_840,
    encryption: "none",
    attestation: "skipped",
    ehbpResponseNonce: null,
    tinfoilRequestId: null,
    usage: { promptTokens: 812, completionTokens: 96, totalTokens: 908 },
    error: null,
    wireCaptured: false,
    traceId: "3123456789abcdef0123456789abcdef",
    responseHeadersAt: NOW - 4 * MIN - 900,
    firstChunkAt: NOW - 4 * MIN - 700,
  },
];

export const bridgeStatus: BridgeStatus = bridgeStatusForPlatform("darwin");

const updateStatus: BridgeUpdateStatus = {
  channel: "alpha",
  checking: false,
  currentVersion: "1.42.0-mock",
  downloaded: false,
  downloading: mockUpdateState === "downloading",
  enabled: true,
  feedUrl: "https://api.alexandria.so/updates/apps/ambient-bridge/alpha/darwin/arm64/",
  updateAvailable: mockUpdateState === "downloading",
  latestVersion: mockUpdateState === "downloading" ? "1.43.0-mock" : "1.42.0-mock",
  downloadPercent: mockUpdateState === "downloading" ? 60 : null,
  releaseNotesUrl: mockUpdateState === "downloading"
    ? "https://api.alexandria.so/changelog/apps/ambient-bridge/alpha/darwin/arm64"
    : null,
  lastCheckedAtMs: NOW - 10 * MIN,
};

function mockCiphertext(length: number, seed: number): string {
  let state = seed >>> 0;
  let binary = "";
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    binary += String.fromCharCode(state & 0xff);
  }
  return btoa(binary);
}

const wireCapture: BridgeWireCapture = {
  requestId: "req-1",
  at: NOW - 2 * MIN,
  request: {
    method: "POST",
    url: "https://api.alexandria.so/v1/chat/completions",
    headers: [
      { name: "content-type", value: "application/json" },
      { name: "ehbp-encapsulated-key", value: "ac7761a7a2a8f6cd5d9fc2e7830d11b735c3108138574fea3f4c06edd5248874" },
      { name: "x-ambient-app-version", value: "1.42.0-mock" },
      { name: "x-ambient-feature", value: "chunk-analysis" },
      { name: "x-ambient-model-id", value: "gemma4-31b" },
      { name: "x-ambient-request-id", value: "req-1" },
      { name: "x-tinfoil-enclave-url", value: "https://router.inf6.tinfoil.sh" },
    ],
    body: { base64: mockCiphertext(8231, 0x4a7c19e3), capturedBytes: 8231, byteLength: 8231, truncated: false },
  },
  response: {
    status: 200,
    headers: [
      { name: "content-type", value: "application/ehbp" },
      { name: "ehbp-response-nonce", value: "95a718b34c08d882ce4f1032" },
    ],
    body: { base64: mockCiphertext(1204, 0x1835db71), capturedBytes: 1204, byteLength: 1204, truncated: false },
  },
};

const truncatedWireCapture: BridgeWireCapture = {
  requestId: "req-3",
  at: NOW - 20 * MIN,
  request: {
    method: "POST",
    url: "https://api.alexandria.so/v1/audio/transcriptions",
    headers: [
      { name: "content-type", value: "application/ehbp" },
      { name: "ehbp-encapsulated-key", value: "8e2c3bb3da2907301b1bf123a11321f0e3a4f09c61fb482334df76018d8462af" },
      { name: "x-ambient-feature", value: "transcription" },
      { name: "x-ambient-model-id", value: "whisper-large-v3-turbo" },
      { name: "x-ambient-request-id", value: "req-3" },
    ],
    body: {
      base64: mockCiphertext(16 * 1024, 0x754b21c8),
      capturedBytes: 16 * 1024,
      byteLength: 240_112,
      truncated: true,
    },
  },
  response: null,
};

function wireCaptureForRequest(requestId: string): BridgeWireCapture | null {
  if (requestId === wireCapture.requestId) return wireCapture;
  if (requestId === truncatedWireCapture.requestId) return truncatedWireCapture;
  return null;
}

const noop = (): void => {};

export function buildBridgeMock(): BridgeUiApi {
  const platform = resolveBridgeMockPlatform();
  const devtoolsEnabled = typeof window === "undefined"
    || new URLSearchParams(window.location.search).get("bridgeMockDevtools") !== "0";
  const status = bridgeStatusForPlatform(platform, devtoolsEnabled);
  const initialStatusDelayMs = Math.max(
    0,
    typeof window === "undefined"
      ? 0
      : Number(new URLSearchParams(window.location.search).get("bridgeMockStatusDelayMs") ?? 0) || 0,
  );
  let firstStatusRead = true;
  let requestLog = [...inferenceRequests];
  let requestLogRevision = 1;
  const requestLogListeners = new Set<(patch: BridgeRequestLogPatch) => void>();
  const statusListeners = new Set<() => void>();

  const api: BridgeUiApi = {
    copyWirePayload: async (requestId: string) => {
      const capture = wireCaptureForRequest(requestId);
      return capture
      ? {
          capturedBytes: capture.request.body.capturedBytes,
          status: "copied" as const,
          truncated: capture.request.body.truncated,
        }
      : { status: requestId === "req-2" ? "pending" as const : "not_captured" as const };
    },
    getStatus: async () => {
      if (firstStatusRead && initialStatusDelayMs > 0) {
        firstStatusRead = false;
        await new Promise((resolve) => setTimeout(resolve, initialStatusDelayMs));
      }
      return status;
    },
    getRequestLog: async () => ({
      revision: requestLogRevision,
      requests: requestLog,
    }),
    getUpdateStatus: async () => updateStatus,
    getWireCapture: async (requestId: string) => wireCaptureForRequest(requestId)
      ? { capture: wireCaptureForRequest(requestId)!, state: "available" as const }
      : requestId === "req-2"
        ? { state: "pending" as const }
        : { state: "not_captured" as const },
    onStatusChanged: (callback) => {
      statusListeners.add(callback);
      return () => {
        statusListeners.delete(callback);
      };
    },
    onRequestLogChanged: (callback) => {
      requestLogListeners.add(callback);
      return () => {
        requestLogListeners.delete(callback);
      };
    },
    onUpdateStatusChanged: () => noop,
    checkForUpdates: async () => updateStatus,
    checkForStableUpdates: async () => updateStatus,
    installUpdate: async () => updateStatus,
    getUninstallAvailability: async () => ({
      available: false,
      reason: "Uninstall is available in packaged Bridge builds.",
      method: null,
    }),
    uninstall: async () => ({ status: "uninstalled" }),
    retryReachability: async () => status,
    viewUpdateReleaseNotes: async () => true,
    startLogin: async () => undefined,
    signOut: async () => undefined,
    switchOrganization: async () => undefined,
    completePairing: async () => status.pairedClientList[0],
    revokeClient: async () => undefined,
  };

  // Test/dev helpers for renderer smoke without waiting on the 15s safety poll.
  (api as BridgeUiApi & {
    clearRequestLogForTests: () => void;
    emitStatusChangedForTests: () => void;
  }).clearRequestLogForTests = () => {
    requestLog = [];
    requestLogRevision += 1;
    const patch: BridgeRequestLogPatch = {
      revision: requestLogRevision,
      upserts: [],
      removeIds: [],
      reset: true,
    };
    for (const listener of requestLogListeners) listener(patch);
  };
  (api as BridgeUiApi & { emitStatusChangedForTests: () => void }).emitStatusChangedForTests = () => {
    for (const listener of statusListeners) listener();
  };

  return api;
}

function bridgeStatusForPlatform(platform: "darwin" | "win32" | "linux", devtoolsEnabled = true): BridgeStatus {
  const pairedClients = pairedClientsForPlatform(platform);
  const resolvedFeatureFlags: BridgeFeatureFlags = devtoolsEnabled
    ? featureFlags
    : {
        ...featureFlags,
        enabledSlugs: featureFlags.enabledSlugs.filter((slug) => slug !== "devtools-visible"),
        capabilities: { ...featureFlags.capabilities, devtooling: false },
        sample: { slug: "devtools-visible", enabled: false },
      };
  return {
    account: {
      kind: "signed_in",
      email: "you@example.com",
      name: "Mock User",
      organizationId: "org-mock",
      organizationName: "Ambient Labs",
      organizations: [
        { id: "org-mock", name: "Ambient Labs" },
        { id: "org-personal", name: "Personal" },
      ],
      featureFlags: resolvedFeatureFlags,
    },
    connection: "ready",
    inference: {
      activeRequests: 1,
      attestation: "verified",
      attestationChecks: [
        { checkedAt: NOW - 2 * MIN, reason: null, requestId: "req-1", status: "passed" },
        { checkedAt: NOW - 20 * MIN, reason: "Upstream enclave unavailable", requestId: "req-3", status: "failed" },
      ],
      attestationInProgress: false,
      encryption: "ehbp",
      lastError: null,
      lastRequest: inferenceRequests[0],
      responsePrivacy: "decrypts_in_bridge",
      serverAuth: "workos_session",
      serverOrigin: "https://api.alexandria.so",
      wireCaptureRevision: 3,
    },
    plaintextInferenceWarningHidden: mockPlaintextInferenceWarningHidden,
    nodeRouting: {
      state: "ready",
      organizationId: null,
      workspaceId: "workspace-personal-mock",
      workspaceKind: "personal",
      installationId: "installation-public-mock",
      origin: "https://public-node.alexandria.so",
      capabilities: ["inference"],
      entitlements: {
        inference: true,
        multiplayer: false,
        publishing: false,
        mcp: false,
      },
      inferenceMode: mockPlaintextInference ? "plaintext" : "confidential",
      configurationVersion: 1,
      message: null,
    },
    pairedClientList: pairedClients,
    pairedClients: pairedClients.filter((c) => c.revokedAt === null).length,
    pairingRequests: [],
    runtimeIdentity: {
      channel: "experimental",
      commitSha: "mock-commit",
      serverUrl: "https://api.alexandria.so",
      serverTarget: "production",
      version: platform === "win32" ? "1.42.0-mock-win" : "1.42.0-mock",
    },
    serverReachable: true,
    serverReachability: "reachable",
    serverReachabilityCheckedAt: NOW - 15_000,
    serverReachabilityHttpStatus: 200,
    serverReachabilityMessage: "Server reachable.",
    serverReachabilityReason: "ok",
    sessionRefresh: {
      attempt: 0,
      message: null,
      nextRetryAt: null,
      state: "ready",
    },
    appVersion: platform === "win32" ? "1.42.0-mock-win" : "1.42.0-mock",
    socketReady: true,
  };
}

function pairedClientsForPlatform(platform: "darwin" | "win32" | "linux"): BridgePairedClient[] {
  const currentClientId = platform === "win32" ? "client-win" : platform === "linux" ? "client-linux" : "client-mac";
  return [
    { id: currentClientId, name: bridgeMockClientLabel(platform), pairedAt: NOW - 72 * 60 * MIN, revokedAt: null },
    { id: "client-old", name: "Ambient", pairedAt: NOW - 30 * 24 * 60 * MIN, revokedAt: null },
  ];
}

export function maybeInstallBridgeMock(): void {
  if (import.meta.env.VITE_AMBIENT_MOCK !== "1") return;
  if (typeof window === "undefined") return;
  if (window.ambientBridge) return; // real preload wins

  const platform = resolveBridgeMockPlatform();
  document.documentElement.dataset.ambientMock = "true";
  document.documentElement.dataset.platform = platform;
  window.ambientBridge = buildBridgeMock();
  // eslint-disable-next-line no-console
  console.info(`[ambient-bridge] mock IPC installed (VITE_AMBIENT_MOCK=1, platform=${platform})`);
}
