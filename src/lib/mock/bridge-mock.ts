// Fake `window.ambientBridge` for the browser / Claude preview, where the
// Electron preload that normally provides it does not exist. Without this the
// bridge renderer only ever shows its hardcoded "starting / signed-out" fallback.
//
// Opt-in via VITE_AMBIENT_MOCK=1 (set on the browser dev server — see the
// `bridge-renderer-mock` config in .claude/launch.json). Installed from main.ts
// before the app mounts; never clobbers a real preload.

import type {
  BridgeExperimentalBuildsSnapshot,
  BridgeFeatureFlags,
  BridgeInferenceRequestStatus,
  BridgePairedClient,
  BridgeStatus,
  BridgeUiApi,
  BridgeUpdateStatus,
  BridgeWireCapture,
} from "../bridge-api";
import {
  bridgeMockArch,
  bridgeMockClientLabel,
  resolveBridgeMockPlatform,
} from "./platform";

const NOW = Date.now();
const MIN = 60_000;
const mockUpdateState = typeof window === "undefined"
  ? null
  : new URLSearchParams(window.location.search).get("bridgeMockUpdate");

const featureFlags: BridgeFeatureFlags = {
  enabledSlugs: [
    "integrations-enabled",
    "automations-enabled",
    "devtools-visible",
    "context-handoff-available",
  ],
  definitions: [],
  capabilities: {
    integrations: true,
    automations: true,
    automationToggleTrack: true,
    devtooling: true,
    contextHandoff: true,
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
  },
  {
    completedAt: null,
    feature: "intent-loop",
    model: "kimi-k2-6",
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
    ? "https://api.alexandria.so/releases/apps/ambient-bridge/alpha/darwin/arm64"
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
  const builds = experimentalBuildsForPlatform(platform);
  const initialStatusDelayMs = Math.max(
    0,
    typeof window === "undefined"
      ? 0
      : Number(new URLSearchParams(window.location.search).get("bridgeMockStatusDelayMs") ?? 0) || 0,
  );
  let firstStatusRead = true;
  return {
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
    getUpdateStatus: async () => updateStatus,
    getWireCapture: async (requestId: string) => wireCaptureForRequest(requestId)
      ? { capture: wireCaptureForRequest(requestId)!, state: "available" as const }
      : requestId === "req-2"
        ? { state: "pending" as const }
        : { state: "not_captured" as const },
    onStatusChanged: () => noop,
    onUpdateStatusChanged: () => noop,
    checkForUpdates: async () => updateStatus,
    checkForStableUpdates: async () => updateStatus,
    installUpdate: async () => updateStatus,
    retryReachability: async () => status,
    viewUpdateReleaseNotes: async () => true,
    listExperimentalBuilds: async () => builds,
    installExperimentalBuild: async (releaseKey: string) => {
      const selected = builds.builds.find((build) => build.releaseKey === releaseKey);
      return {
        ...updateStatus,
        channel: "experimental",
        downloading: true,
        latestVersion: selected?.version,
        updateAvailable: true,
      };
    },
    startLogin: async () => undefined,
    signOut: async () => undefined,
    switchOrganization: async () => undefined,
    completePairing: async () => status.pairedClientList[0],
    revokeClient: async () => undefined,
  };
}

function bridgeStatusForPlatform(platform: "darwin" | "win32" | "linux", devtoolsEnabled = true): BridgeStatus {
  const clientLabel = bridgeMockClientLabel(platform);
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
    activity: [
      { name: "pairing.completed", at: NOW - 60 * MIN, fields: { client: clientLabel } },
      { name: "inference.request", at: NOW - 2 * MIN, fields: { feature: "chunk-analysis", status: "completed" } },
      { name: "attestation.verified", at: NOW - 2 * MIN, fields: { requestId: "req-1" } },
    ],
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
      requests: inferenceRequests,
      responsePrivacy: "decrypts_in_bridge",
      serverAuth: "workos_session",
      serverOrigin: "https://api.alexandria.so",
      wireCaptureRevision: 3,
    },
    pairedClientList: pairedClients,
    pairedClients: pairedClients.filter((c) => c.revokedAt === null).length,
    pairingRequests: [],
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

function experimentalBuildsForPlatform(platform: "darwin" | "win32" | "linux"): BridgeExperimentalBuildsSnapshot {
  const arch = bridgeMockArch(platform);
  return {
    channel: "experimental",
    platform,
    arch,
    currentVersion: platform === "win32" ? "1.42.0-mock-win" : "1.42.0-mock",
    releasesUrl: `https://api.alexandria.so/releases/apps/ambient-bridge/experimental/${platform}/${arch}`,
    builds: [
      {
        id: "rel_bridge_mock_149",
        releaseKey: "id:rel_bridge_mock_149",
        version: "0.1.0-experimental.pr310.29316949420",
        channel: "experimental",
        platform,
        arch,
        commitSha: "87bc3a3d257cc8a8aa8824eaec4245ab0babe0aa",
        notes: "Packaged Bridge request inspector",
        releasedAt: "2026-07-14T08:13:19.039Z",
      },
      {
        id: "rel_bridge_mock_148",
        releaseKey: "id:rel_bridge_mock_148",
        version: "0.1.0-experimental.pr310.29316331298",
        channel: "experimental",
        platform,
        arch,
        commitSha: "8204b8f3697419007e9350ffe8f721caa7b6ff7d",
        notes: null,
        releasedAt: "2026-07-14T08:02:57.520Z",
      },
    ],
  };
}

export function maybeInstallBridgeMock(): void {
  if (import.meta.env.VITE_AMBIENT_MOCK !== "1") return;
  if (typeof window === "undefined") return;
  if (window.ambientBridge) return; // real preload wins

  window.ambientBridge = buildBridgeMock();
  // eslint-disable-next-line no-console
  console.info("[ambient-bridge] mock IPC installed (VITE_AMBIENT_MOCK=1) — using fake data");
}
