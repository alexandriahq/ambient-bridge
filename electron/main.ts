import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, safeStorage, shell } from "electron";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { BridgeIpcServer, type IpcHandlerContext, type IpcStream } from "./ipc-server/socket.js";
import type { BridgeRequestFrame, JsonValue } from "./ipc-server/protocol.js";
import { PairingStore, type PairedClient, type PairingRequest, type PairingResult } from "./ipc-server/pairing.js";
import { signDescriptor, writeDescriptorFile } from "./ipc-server/descriptor.js";
import { createDeviceIdentity } from "./devices/identity.js";
import { MemoryAuditSink } from "./diagnostics/audit.js";
import { EncryptedSessionStore } from "./workos/token-store.js";
import {
  shouldRefreshWorkOsSession,
  type SignedInWorkOsSession,
  type WorkOsOrganization,
  type WorkOsSession,
} from "./workos/session.js";
import { streamResponseBody } from "./proxy/streaming.js";
import {
  AuthServerRequestError,
  AuthServerClient,
  BRIDGE_RETURN_URI,
  parseBridgeAuthCallback,
  serverBaseUrlFromEnv,
  type AuthBrokerSessionResponse,
} from "./auth/server-client.js";
import {
  BridgeAuditService,
  BridgeSecureClient,
  BridgeSessionService,
  createBridgeAuditService,
  createBridgeSecureClient,
  createBridgeSessionService,
  secureInferenceResponse,
  type BridgeSecureClientShape,
  type InferenceProxyPath,
} from "./inference/effect.js";
import { forwardHandoffFeedback } from "./analytics/handoff-feedback.js";
import { audioTranscriptionRequestFromPayload, audioUploadMetadataFromPayload } from "./inference/audio-transcription.js";
import { NetworkRequestHistory, readEhbpResponseEvidence, type NetworkRequestRecord } from "./inference/network-log.js";
import { WireTap, type WireCapture } from "./inference/wire-tap.js";
import {
  BRIDGE_RELEASE_DEFAULT_CHANNEL,
  bridgeUpdateFeedUrl,
  bridgeUpdaterUnavailableReason,
} from "./update-feed.js";
import { ServerReachabilityMonitor, type ServerReachabilityState } from "./reachability.js";
import { errorMessage } from "./error-message.js";

const { autoUpdater } = createRequire(import.meta.url)("electron-updater") as typeof import("electron-updater");

type BridgeAccountState =
  | { kind: "signed_out" }
  | { kind: "login_pending"; userCode?: string; verificationUri?: string }
  | {
      kind: "signed_in";
      email: string;
      name?: string;
      profilePictureUrl?: string;
      organizationId?: string;
      organizationName?: string;
      organizations?: WorkOsOrganization[];
      featureFlags: BridgeFeatureFlags;
    };

type BridgeFeatureFlags = {
  enabledSlugs: string[];
  definitions: BridgeFeatureFlagDefinition[];
  capabilities: BridgeFeatureFlagCapabilities;
  evaluatedFor: {
    userId: string;
    organizationId: string | null;
  };
  sample: {
    slug: string;
    enabled: boolean;
  };
  source: "organization" | "user";
};

type BridgeFeatureFlagKey =
  | "integrations"
  | "automations"
  | "automationToggleTrack"
  | "devtooling"
  | "contextHandoff";

type BridgeFeatureFlagFamily = "integrations" | "automations" | "devtools" | "context";

type BridgeFeatureFlagDefinition = {
  key: BridgeFeatureFlagKey;
  slug: string;
  title: string;
  family: BridgeFeatureFlagFamily;
  description: string;
  requiresKey?: BridgeFeatureFlagKey;
};

type BridgeFeatureFlagCapabilities = Record<BridgeFeatureFlagKey, boolean>;

type BridgeStatus = {
  account: BridgeAccountState;
  activity: BridgeActivityEvent[];
  authError?: string;
  appVersion: string;
  connection: "ready" | "starting" | "checking" | "proxy_unavailable" | "attestation_invalid" | "offline";
  inference: BridgeInferenceStatus;
  pairedClientList: BridgePairedClient[];
  pairedClients: number;
  pairingRequests: BridgePairingRequest[];
  serverReachable: boolean;
  serverReachability: ServerReachabilityState;
  socketReady: boolean;
};

type BridgeActivityEvent = {
  name: string;
  at: number;
  fields: Record<string, string | number | boolean | null>;
};

type BridgePairingRequest = {
  id: string;
  clientName: string;
  requestedAt: number;
  status: "pending" | "approved" | "rejected";
};

type BridgePairedClient = {
  id: string;
  name: string;
  pairedAt: number;
  revokedAt: number | null;
};

type BridgeInferenceStatus = {
  activeRequests: number;
  attestation: "not_checked" | "verifying" | "verified" | "failed";
  attestationChecks: BridgeAttestationCheck[];
  attestationInProgress: boolean;
  encryption: "ehbp";
  lastError: string | null;
  lastRequest: BridgeInferenceRequestStatus | null;
  requests: BridgeInferenceRequestStatus[];
  responsePrivacy: "decrypts_in_bridge";
  serverAuth: "workos_session";
  serverOrigin: string;
};

type BridgeAttestationCheck = {
  checkedAt: number;
  reason: string | null;
  requestId: string;
  status: "passed" | "failed";
};

type BridgeInferenceRequestStatus = NetworkRequestRecord;

type BridgeUpdateStatus = {
  channel: string;
  checking: boolean;
  currentVersion: string;
  downloaded: boolean;
  downloading: boolean;
  enabled: boolean;
  feedUrl: string | null;
  latestVersion?: string;
  reason?: string;
  updateAvailable: boolean;
  updateError?: string;
};

type PendingLogin = {
  callbackReturnUri: string;
  callbackServer?: HttpServer;
  callbackTimeout?: NodeJS.Timeout;
  clientState: string;
};

type SecureInferenceRequestOverrides = Pick<Parameters<typeof secureInferenceResponse>[0], "body" | "contentType" | "accept">;

const LOGIN_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const ATTESTATION_HISTORY_LIMIT = 10;
const SERVER_REACHABILITY_TTL_MS = 8_000;
const SERVER_REACHABILITY_TIMEOUT_MS = 2_500;
const IPC_SOCKET_HEALTH_INTERVAL_MS = 15_000;
const AMBIENT_SESSION_TOKEN_HEADER = "x-ambient-session-token";
const STALE_SESSION_MESSAGE = "Your Bridge sign-in expired. Sign in again to continue.";
const APP_NAME = "Ambient Bridge";
const AMBIENT_FEATURE_FLAG_DEFINITIONS: readonly BridgeFeatureFlagDefinition[] = [
  {
    key: "integrations",
    slug: "integrations-enabled",
    title: "Integrations",
    family: "integrations",
    description: "Shows and enables the integrations area in general.",
  },
  {
    key: "automations",
    slug: "automations-enabled",
    title: "Automations",
    family: "automations",
    description: "Shows and enables the automations area in general.",
  },
  {
    key: "automationToggleTrack",
    slug: "automations-toggle-track-available",
    title: "Toggle Track automation",
    family: "automations",
    description: "Enables the specific Toggle Track automation capability.",
    requiresKey: "automations",
  },
  {
    key: "devtooling",
    slug: "devtools-visible",
    title: "Dev tooling",
    family: "devtools",
    description: "Shows internal and developer-only tooling.",
  },
  {
    key: "contextHandoff",
    slug: "context-handoff-available",
    title: "Context Handoff",
    family: "context",
    description: "Enables Ambient-native Context Handoff.",
  },
];

app.setName(APP_NAME);

// In dev the dock/taskbar would otherwise show the stock Electron icon.
// Packaged builds get their icon from the bundle's .icns (electron-builder).
function applyDevDockIcon(): void {
  if (process.platform !== "darwin" || app.isPackaged || !app.dock) return;
  // main.js runs from dist/electron/, so resources/ sits two levels up.
  const iconPath = join(import.meta.dirname, "..", "..", "resources", "bridge-icon-source.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) {
    app.dock.setIcon(icon);
  }
}

function resolveBridgeWindowIconPath(): string | undefined {
  if (process.platform === "darwin") return undefined;
  const iconFile = process.platform === "win32" ? "bridge-icon.ico" : "bridge-icon-source.png";
  const sourceRoot = join(import.meta.dirname, "..", "..");
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, iconFile),
        join(sourceRoot, "resources", iconFile),
      ]
    : [
        join(sourceRoot, "resources", iconFile),
        join(process.cwd(), "resources", iconFile),
      ];
  return candidates.find((candidate) => existsSync(candidate));
}

let mainWindow: BrowserWindow | undefined;
let ipcServer: BridgeIpcServer | undefined;
let pendingLogin: PendingLogin | undefined;
let authError: string | undefined;
let workOsSessionStore: EncryptedSessionStore | undefined;
let organizationsRefresh: Promise<void> | null = null;
const statusEvents = new EventEmitter();
statusEvents.setMaxListeners(50);

const audit = new MemoryAuditSink();
let pairingStore = new PairingStore();
const identity = createDeviceIdentity();
const serverBaseUrl = serverBaseUrlFromEnv();
const activeInferenceRequests = new Map<string, AbortController>();
const activeAttestationChecks = new Set<string>();
const networkHistory = new NetworkRequestHistory();
const wireTap = new WireTap({
  onUpdate: (requestId) => {
    networkHistory.patch(requestId, { wireCaptured: true });
    notifyStatusChanged();
  },
});
wireTap.install();
const bridgeAuditService = createBridgeAuditService(audit);
const bridgeSecureClient = createBridgeSecureClient({ serverBaseUrl });
let inferenceStatus: BridgeInferenceStatus = initialInferenceStatus();
const authServer = new AuthServerClient({ baseUrl: serverBaseUrl });
const releaseChannel = process.env.AMBIENT_BRIDGE_RELEASE_CHANNEL ?? BRIDGE_RELEASE_DEFAULT_CHANNEL;
let updateStatus = initialUpdateStatus();
let updateEventsRegistered = false;
const serverReachability = new ServerReachabilityMonitor({
  onReachabilityChange: (reachable) => {
    audit.record("server.reachability_changed", { reachable });
  },
  onStateChange: notifyStatusChanged,
  probe: () => authServer.checkHealth({
    timeoutMs: SERVER_REACHABILITY_TIMEOUT_MS,
  }),
  ttlMs: SERVER_REACHABILITY_TTL_MS,
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  void handleAuthCallback(url);
});

async function createMainWindow(): Promise<void> {
  nativeTheme.themeSource = "light";

  const preload = join(import.meta.dirname, "preload.cjs");
  const icon = resolveBridgeWindowIconPath();
  const useMacWindowChrome = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    height: 720,
    minHeight: 560,
    minWidth: 860,
    backgroundColor: useMacWindowChrome ? "#00000000" : "#ffffff",
    ...(icon ? { icon } : {}),
    title: APP_NAME,
    titleBarStyle: useMacWindowChrome ? "hiddenInset" : "default",
    ...(useMacWindowChrome ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
    transparent: useMacWindowChrome,
    vibrancy: useMacWindowChrome ? "fullscreen-ui" : undefined,
    visualEffectState: useMacWindowChrome ? "active" : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload,
      sandbox: true,
    },
    width: 1040,
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[bridge] renderer process gone", details);
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[bridge] renderer failed to load", { errorCode, errorDescription, validatedURL });
  });

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    console.log(`[bridge] loading renderer dev server ${process.env.VITE_DEV_SERVER_URL}`);
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    const rendererPath = join(import.meta.dirname, "../renderer/index.html");
    console.log(`[bridge] loading packaged renderer ${rendererPath}`);
    await mainWindow.loadFile(rendererPath);
  }

  if (process.env.AMBIENT_BRIDGE_OPEN_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

let ipcSocketRepair: Promise<boolean> | null = null;

/**
 * The "Listening" status must reflect disk reality, not just that the server
 * object exists: another process (or an older Bridge instance) can delete the
 * socket file while our listener survives on the unlinked inode, leaving
 * clients with ENOENT. When that happens, rebind the socket and rewrite the
 * descriptor instead of reporting a healthy socket that no client can reach.
 */
async function ensureIpcSocketAlive(): Promise<boolean> {
  if (!ipcServer) return false;
  if (process.platform === "win32") return true;
  if (existsSync(ipcServer.socketPath)) return true;
  ipcSocketRepair ??= repairIpcSocket().finally(() => {
    ipcSocketRepair = null;
  });
  return ipcSocketRepair;
}

async function repairIpcSocket(): Promise<boolean> {
  const socketPath = ipcServer?.socketPath ?? null;
  console.error("[bridge] IPC socket file disappeared; rebinding", { socketPath });
  audit.record("ipc.socket_missing_rebind", { socketPath });
  try {
    await ipcServer?.stop();
  } catch (error) {
    audit.record("ipc.socket_rebind_stop_failed", { message: safeStatusMessage(errorMessage(error)) });
  }
  ipcServer = undefined;
  try {
    const restarted = await startIpcServer();
    notifyStatusChanged();
    return existsSync(restarted.socketPath);
  } catch (error) {
    audit.record("ipc.socket_rebind_failed", { message: safeStatusMessage(errorMessage(error)) });
    notifyStatusChanged();
    return false;
  }
}

async function startIpcServer(): Promise<BridgeIpcServer> {
  const supportDir = bridgeIpcSupportDir();
  const socketPath = bridgeIpcSocketPath(supportDir);
  const descriptorPath = join(supportDir, "bridge.json");

  const server = new BridgeIpcServer({
    audit,
    handlers: {
      "bridge.health": async () => ({ ok: true, version: app.getVersion() }),
      "bridge.status": async (frame) => getStatus({ forceRefreshSession: payloadBoolean(frame.payload, "refreshSession") }),
      "bridge.statusSubscribe": (_frame, context) => statusSubscriptionStream(context.socketClosed),
      "auth.integrationToken": async () => integrationTokenPayload(),
      "auth.session": async () => localSessionPayload(),
      "auth.signIn": async () => signInViaIpc(),
      "auth.signOut": async () => {
        await performSignOut();
        return { ok: true };
      },
      "auth.switchOrganization": async (frame) => {
        const organizationId = payloadString(frame.payload, "organizationId");
        if (!organizationId) {
          throw new Error("organizationId is required.");
        }
        return switchOrganization(organizationId);
      },
      "auth.organizations": async () => organizationsPayload(),
      "analytics.handoffFeedback": async (frame) => forwardHandoffFeedbackAnalytics(frame),
      "inference.audioSpeech": async () => unsupportedInferenceMethod("inference.audioSpeech"),
      "inference.audioTranscriptions": (frame, context) => forwardAudioTranscription(frame, context),
      "inference.chatCompletions": (frame) => forwardInference(frame, "/v1/chat/completions"),
      "inference.embeddings": async () => unsupportedInferenceMethod("inference.embeddings"),
      "inference.responses": (frame) => forwardInference(frame, "/v1/responses"),
      "inference.cancel": async (frame) => cancelInference(frame),
      "pair.start": async (frame) => {
        const clientName =
          frame.payload && typeof frame.payload === "object" && "clientName" in frame.payload
            ? String(frame.payload.clientName)
            : "Ambient";
        const request = pairingStore.start(clientName);
        const client = pairingStore.complete(request.id, true);
        audit.record("pairing.requested", { clientName, requestId: request.id });
        audit.record("pairing.auto_approve", {
          clientId: client?.id ?? null,
          requestId: request.id,
        });
        notifyStatusChanged();
        return publicPairingRequest(request) as unknown as Record<string, string | number>;
      },
      "pair.complete": async (frame) => {
        const requestId = payloadString(frame.payload, "requestId");
        if (!requestId) {
          return { status: "unknown" };
        }
        return publicPairingResult(pairingStore.resultForRequest(requestId));
      },
    },
    pairingStore,
    socketPath,
  });

  await server.start();
  ipcServer = server;
  const descriptor = signDescriptor(
    {
      instanceId: randomUUID(),
      pid: process.pid,
      publicPairingKey: identity.publicKeyPem,
      socketPath,
      version: app.getVersion(),
    },
    identity.privateKeyPem,
  );
  await writeDescriptorFile(descriptorPath, descriptor);
  audit.record("ipc.started", { descriptorPath, socketPath });
  return server;
}

function bridgeIpcSupportDir(): string {
  return join(app.getPath("appData"), APP_NAME);
}

function bridgeIpcSocketPath(supportDir: string): string {
  if (process.platform === "win32") {
    const pipeName = supportDir
      .replace(/^[a-z]:/i, "")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    return `\\\\.\\pipe\\ambient-bridge-${pipeName || "default"}`;
  }
  return join(supportDir, "bridge.sock");
}

async function getStatus(options: { readonly forceRefreshSession?: boolean } = {}): Promise<BridgeStatus> {
  if (options.forceRefreshSession) {
    await refreshStoredSession({ force: true });
  }
  const [session, reachability, socketReady] = await Promise.all([
    sessionStore().read(),
    currentServerReachability(),
    ensureIpcSocketAlive(),
  ]);
  const account = pendingLogin
    ? { kind: "login_pending" as const }
    : publicAccountState(session);
  const serverReachable = reachability === "reachable";

  return {
    account,
    activity: recentActivity(),
    appVersion: app.getVersion(),
    authError,
    connection: connectionState({ reachability, socketReady }),
    inference: {
      ...inferenceStatus,
      activeRequests: activeInferenceRequests.size,
      attestationChecks: inferenceStatus.attestationChecks.map((check) => ({ ...check })),
      attestationInProgress: activeAttestationChecks.size > 0,
      lastRequest: networkHistory.latest(),
      requests: networkHistory.list(),
    },
    pairedClientList: pairingStore.listClients().map(publicPairedClient),
    pairedClients: pairingStore.listClients().filter((client) => !client.credential.revokedAt).length,
    pairingRequests: pairingStore.listRequests()
      .filter((request) => request.status === "pending")
      .map(publicPairingRequest),
    serverReachable,
    serverReachability: reachability,
    socketReady,
  };
}

function currentServerReachability(): ServerReachabilityState {
  return serverReachability.current();
}

function connectionState(input: {
  reachability: ServerReachabilityState;
  socketReady: boolean;
}): BridgeStatus["connection"] {
  if (!input.socketReady) return "starting";
  if (input.reachability === "checking") return "checking";
  if (input.reachability === "unavailable") return "proxy_unavailable";
  return "ready";
}

function recentActivity(): BridgeActivityEvent[] {
  return audit.recent().slice(-200).reverse().map((event) => ({
    at: event.at,
    fields: Object.fromEntries(
      Object.entries(event.fields)
        .filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined),
    ),
    name: event.name,
  }));
}

ipcMain.handle("bridge:get-status", () => getStatus());
ipcMain.handle("bridge:get-update-status", () => getUpdateStatus());
ipcMain.handle("bridge:get-wire-capture", (_event, requestId: string): WireCapture | null => {
  return typeof requestId === "string" ? wireTap.get(requestId) : null;
});

ipcMain.handle("bridge:check-for-updates", async () => checkForBridgeUpdates());

ipcMain.handle("bridge:install-update", () => installBridgeUpdate());

async function startLoginFlow(options: { organizationId?: string } = {}): Promise<void> {
  authError = undefined;
  closePendingLoginCallback();
  const clientState = randomBytes(32).toString("base64url");
  const callbackTarget = await createAuthCallbackTarget();
  const callbackTimeout = setTimeout(() => {
    handleLoginTimeout(clientState);
  }, LOGIN_CALLBACK_TIMEOUT_MS);
  callbackTimeout.unref();
  pendingLogin = {
    callbackReturnUri: callbackTarget.returnUri,
    callbackServer: callbackTarget.server,
    callbackTimeout,
    clientState,
  };

  const loginUrl = authServer.createLoginUrl(
    pendingLogin.clientState,
    pendingLogin.callbackReturnUri,
    options.organizationId,
  );
  audit.record("auth.login_start", {});
  console.info("[bridge:auth] opening browser sign-in", {
    callbackMode: pendingLogin.callbackServer ? "loopback" : "protocol",
    returnUri: pendingLogin.callbackReturnUri,
  });
  notifyStatusChanged();
  try {
    await shell.openExternal(loginUrl);
  } catch (error) {
    closePendingLoginCallback();
    authError = errorMessage(error);
    notifyStatusChanged();
    throw error;
  }
}

async function performSignOut(): Promise<void> {
  const store = sessionStore();
  const session = await store.read();
  if (session.kind === "signed_in") {
    try {
      const logoutUrl = await authServer.createLogoutUrl(session.sessionToken);
      await shell.openExternal(logoutUrl);
    } catch (error) {
      audit.record("auth.logout_remote_failed", { message: errorMessage(error) });
    }
  }

  closePendingLoginCallback();
  authError = undefined;
  await store.clear();
  audit.record("auth.sign_out", {});
  notifyStatusChanged();
}

ipcMain.handle("bridge:start-login", () => startLoginFlow());

ipcMain.handle("bridge:sign-out", () => performSignOut());

ipcMain.handle("bridge:switch-organization", async (_event, organizationId: string) => {
  if (typeof organizationId !== "string" || !organizationId) {
    throw new Error("organizationId is required.");
  }
  return switchOrganization(organizationId);
});

ipcMain.handle("bridge:revoke-client", async (_event, clientId: string) => {
  const revoked = pairingStore.revoke(clientId);
  audit.record("pairing.revoke", { clientId, revoked });
  notifyStatusChanged();
  return revoked;
});

ipcMain.handle("bridge:complete-pairing", async (_event, requestId: string, approved: boolean) => {
  if (typeof requestId !== "string" || !requestId) {
    throw new Error("Pairing request id is required.");
  }
  const client = pairingStore.complete(requestId, Boolean(approved));
  audit.record(approved ? "pairing.approve" : "pairing.reject", {
    clientId: client?.id ?? null,
    requestId,
  });
  notifyStatusChanged();
  return client ? publicPairedClient(client) : null;
});

// All Bridge instances share one userData dir (descriptor + IPC socket), so a
// second instance would delete the live socket on start/quit and strand the
// first one. Enforce a single instance before any socket/descriptor work.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  console.error("[bridge] another Ambient Bridge instance is already running; exiting");
  app.exit(0);
}
app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    void createMainWindow();
  }
});

app.whenReady().then(async () => {
  console.log("[bridge] app ready");
  applyDevDockIcon();
  if (!useLoopbackAuthCallback()) {
    registerAuthCallbackProtocol();
  }
  pairingStore = new PairingStore();
  await startIpcServer();
  const socketHealthTimer = setInterval(() => {
    void ensureIpcSocketAlive();
  }, IPC_SOCKET_HEALTH_INTERVAL_MS);
  socketHealthTimer.unref?.();
  configureBridgeUpdater();
  // Refill the organization directory after restarts so org switching works
  // without waiting for the first sign-in or token refresh.
  void refreshOrganizations();
  await createMainWindow();
}).catch((error) => {
  console.error("[bridge] startup failed", error);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  await ipcServer?.stop();
});

function registerAuthCallbackProtocol(): void {
  const electronProcess = process as NodeJS.Process & { defaultApp?: boolean };
  const registered = electronProcess.defaultApp && process.argv[1]
    ? app.setAsDefaultProtocolClient("ambient-bridge", process.execPath, [process.argv[1]])
    : app.setAsDefaultProtocolClient("ambient-bridge");
  audit.record("auth.protocol_register", { registered });
}

async function handleAuthCallback(rawUrl: string): Promise<void> {
  const login = pendingLogin;
  try {
    if (!login) {
      throw new Error("Bridge auth callback arrived without a pending login.");
    }
    console.info("[bridge:auth] callback received");
    audit.record("auth.callback_received", {});
    const callback = parseBridgeAuthCallback(rawUrl, login.clientState);
    if (callback.kind === "error") {
      throw new Error(callback.errorDescription ?? callback.error);
    }

    const authSession = await authServer.redeemTicket(callback.ticket);
    console.info("[bridge:auth] ticket redeemed", { userId: authSession.user.id });
    audit.record("auth.ticket_redeemed", { userId: authSession.user.id });

    await sessionStore().write(toStoredSession(authSession));
    console.info("[bridge:auth] session stored");
    audit.record("auth.session_stored", {});
    pendingLogin = undefined;
    authError = undefined;
    audit.record("auth.login_complete", {
      userId: authSession.user.id,
    });
    void refreshOrganizations();
  } catch (error) {
    authError = errorMessage(error);
    console.error("[bridge:auth] login failed", authError);
    audit.record("auth.login_failed", { message: authError });
  } finally {
    clearLoginResources(login);
    if (pendingLogin === login) {
      pendingLogin = undefined;
    }
  }

  notifyStatusChanged();
  showMainWindow();
}

async function createAuthCallbackTarget(): Promise<{
  returnUri: string;
  server?: HttpServer;
}> {
  if (!useLoopbackAuthCallback()) {
    return { returnUri: BRIDGE_RETURN_URI };
  }

  const server = createHttpServer((request, response) => {
    handleLoopbackAuthRequest(request.url ?? "/", request.headers.host, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    closeAuthCallbackServer(server);
    throw new Error("Could not start Bridge auth callback listener.");
  }

  return {
    returnUri: `http://127.0.0.1:${address.port}/auth/callback`,
    server,
  };
}

function handleLoopbackAuthRequest(path: string, host: string | undefined, response: {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body: string): void;
}): void {
  const requestUrl = new URL(path, `http://${host ?? "127.0.0.1"}`);
  if (requestUrl.pathname !== "/auth/callback") {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end("<!doctype html><title>Ambient Bridge</title><p>Sign-in complete. You can return to Ambient Bridge.</p>");
  void handleAuthCallback(`${BRIDGE_RETURN_URI}${requestUrl.search}`);
}

function useLoopbackAuthCallback(): boolean {
  const mode = process.env.AMBIENT_BRIDGE_AUTH_CALLBACK_MODE;
  if (mode === "protocol") return false;
  if (mode === "loopback") return true;
  if (process.platform === "win32") return true;
  return !app.isPackaged;
}

function closePendingLoginCallback(): void {
  clearLoginResources(pendingLogin);
  pendingLogin = undefined;
}

function handleLoginTimeout(clientState: string): void {
  if (!pendingLogin || pendingLogin.clientState !== clientState) return;
  clearLoginResources(pendingLogin);
  pendingLogin = undefined;
  authError = "Sign-in timed out waiting for the browser callback. Check that the server is reachable and try again.";
  console.error("[bridge:auth] login timed out waiting for callback");
  audit.record("auth.login_timeout", {});
  notifyStatusChanged();
  showMainWindow();
}

function clearLoginResources(login: PendingLogin | undefined): void {
  if (!login) return;
  if (login.callbackTimeout) {
    clearTimeout(login.callbackTimeout);
  }
  closeAuthCallbackServer(login.callbackServer);
}

function closeAuthCallbackServer(server: HttpServer | undefined): void {
  if (!server || !server.listening) return;
  server.close((error) => {
    if (error) {
      audit.record("auth.callback_close_failed", { message: error.message });
    }
  });
}

function publicPairingRequest(request: PairingRequest): BridgePairingRequest {
  return {
    clientName: request.clientName,
    id: request.id,
    requestedAt: request.requestedAt,
    status: request.status,
  };
}

function publicPairedClient(client: PairedClient): BridgePairedClient {
  return {
    id: client.id,
    name: client.name,
    pairedAt: client.pairedAt,
    revokedAt: client.credential.revokedAt ?? null,
  };
}

function publicPairingResult(result: PairingResult): JsonValue {
  if (result.status === "unknown") {
    return { status: "unknown" };
  }
  if (result.status === "pending" || result.status === "rejected") {
    return {
      request: publicPairingRequest(result.request) as unknown as JsonValue,
      status: result.status,
    };
  }
  return {
    client: {
      id: result.client.id,
      name: result.client.name,
      pairedAt: result.client.pairedAt,
      credential: {
        id: result.client.credential.id,
        secret: result.client.credential.secret,
      },
    },
    request: publicPairingRequest(result.request) as unknown as JsonValue,
    status: "approved",
  };
}

function payloadString(payload: JsonValue | undefined, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = payload[key];
  return typeof value === "string" && value ? value : null;
}

function payloadBoolean(payload: JsonValue | undefined, key: string): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  return payload[key] === true;
}

function initialInferenceStatus(): BridgeInferenceStatus {
  return {
    activeRequests: 0,
    attestation: "not_checked",
    attestationChecks: [],
    attestationInProgress: false,
    encryption: "ehbp",
    lastError: null,
    lastRequest: null,
    requests: [],
    responsePrivacy: "decrypts_in_bridge",
    serverAuth: "workos_session",
    serverOrigin: publicOrigin(serverBaseUrl),
  };
}

function startInferenceStatus(
  frame: BridgeRequestFrame,
  path: InferenceProxyPath,
  requestBytes: number | null,
): void {
  inferenceStatus = { ...inferenceStatus, lastError: null };
  networkHistory.start({
    feature: frame.method,
    model: payloadString(frame.payload, "model"),
    path,
    requestBytes,
    requestId: frame.id,
    startedAt: Date.now(),
  });
  notifyStatusChanged();
}

function beginInferenceAttestationCheck(requestId: string): void {
  activeAttestationChecks.add(requestId);
  inferenceStatus = {
    ...inferenceStatus,
    attestation: inferenceStatus.attestation === "verified" ? "verified" : "verifying",
    attestationInProgress: true,
  };
  networkHistory.patch(requestId, { attestation: "pending" });
  notifyStatusChanged();
}

function completeInferenceAttestationCheck(requestId: string): void {
  activeAttestationChecks.delete(requestId);
  inferenceStatus = {
    ...inferenceStatus,
    attestation: "verified",
    attestationChecks: recentAttestationChecks({
      checkedAt: Date.now(),
      reason: null,
      requestId,
      status: "passed",
    }),
    attestationInProgress: activeAttestationChecks.size > 0,
  };
  networkHistory.patch(requestId, { attestation: "verified" });
  notifyStatusChanged();
}

function failInferenceAttestationCheck(requestId: string, reason: string): void {
  activeAttestationChecks.delete(requestId);
  inferenceStatus = {
    ...inferenceStatus,
    attestation: "failed",
    attestationChecks: recentAttestationChecks({
      checkedAt: Date.now(),
      reason: safeStatusMessage(reason),
      requestId,
      status: "failed",
    }),
    attestationInProgress: activeAttestationChecks.size > 0,
  };
  networkHistory.patch(requestId, { attestation: "failed" });
  notifyStatusChanged();
}

function recentAttestationChecks(nextCheck: BridgeAttestationCheck): BridgeAttestationCheck[] {
  return [
    nextCheck,
    ...inferenceStatus.attestationChecks.filter((check) => check.requestId !== nextCheck.requestId),
  ].slice(0, ATTESTATION_HISTORY_LIMIT);
}

function secureClientWithAttestationStatus(requestId: string): BridgeSecureClientShape {
  return {
    fetch: bridgeSecureClient.fetch,
    ready: () =>
      Effect.sync(() => beginInferenceAttestationCheck(requestId)).pipe(
        Effect.flatMap(() => bridgeSecureClient.ready()),
        Effect.tap(() => Effect.sync(() => completeInferenceAttestationCheck(requestId))),
        Effect.tapError((error) => Effect.sync(() => failInferenceAttestationCheck(requestId, errorMessage(error)))),
      ),
  };
}

function updateInferenceRequest(
  requestId: string,
  patch: Partial<BridgeInferenceRequestStatus>,
): void {
  networkHistory.patch(requestId, patch);
}

function completeInferenceStatus(
  requestId: string,
  status: Extract<BridgeInferenceRequestStatus["status"], "completed" | "cancelled">,
): void {
  updateInferenceRequest(requestId, {
    completedAt: Date.now(),
    status,
  });
  notifyStatusChanged();
}

function failInferenceStatus(requestId: string, message: string): void {
  inferenceStatus = {
    ...inferenceStatus,
    lastError: safeStatusMessage(message),
  };
  updateInferenceRequest(requestId, {
    completedAt: Date.now(),
    error: safeStatusMessage(message),
    status: "failed",
  });
}

function publicOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function safeStatusMessage(value: string): string {
  return value.slice(0, 220);
}

function forwardInference(frame: BridgeRequestFrame, path: InferenceProxyPath): IpcStream {
  const abortController = new AbortController();
  activeInferenceRequests.set(frame.id, abortController);
  startInferenceStatus(frame, path, jsonPayloadByteLength(frame.payload));
  return inferenceResponseStream(frame, path, abortController);
}

function forwardAudioTranscription(frame: BridgeRequestFrame, context: IpcHandlerContext): IpcStream {
  const abortController = new AbortController();
  const path: InferenceProxyPath = "/v1/audio/transcriptions";
  activeInferenceRequests.set(frame.id, abortController);
  const metadata = audioUploadMetadataFromPayload(frame.payload);
  startInferenceStatus(frame, path, metadata.expectedByteLength);
  return inferenceResponseStream(
    frame,
    path,
    abortController,
    prepareAudioTranscriptionRequest(frame, context, metadata),
  );
}

function jsonPayloadByteLength(payload: JsonValue | undefined): number {
  return Buffer.byteLength(JSON.stringify(payload ?? {}));
}

async function prepareAudioTranscriptionRequest(
  frame: BridgeRequestFrame,
  context: IpcHandlerContext,
  metadata: ReturnType<typeof audioUploadMetadataFromPayload>,
): Promise<SecureInferenceRequestOverrides> {
  const audio = await context.readBinaryUpload({
    expectedByteLength: metadata.expectedByteLength,
    expectedSha256: metadata.expectedSha256,
    maxBytes: metadata.expectedByteLength,
  });
  return audioTranscriptionRequestFromPayload(frame.payload, audio);
}

async function* inferenceResponseStream(
  frame: BridgeRequestFrame,
  path: InferenceProxyPath,
  abortController: AbortController,
  request?: SecureInferenceRequestOverrides | Promise<SecureInferenceRequestOverrides>,
): IpcStream {
  audit.record("inference.forward_start", {
    method: frame.method,
    path,
    requestId: frame.id,
  });

  try {
    const response = await Effect.runPromise(
      secureInferenceResponse({
        appVersion: app.getVersion(),
        feature: frame.method,
        path,
        payload: frame.payload,
        ...await request,
        requestId: frame.id,
        signal: abortController.signal,
      }).pipe(
        Effect.provideService(
          BridgeSessionService,
          createBridgeSessionService({
            read: () => sessionStore().read(),
            validate: refreshInferenceSessionIfNeeded,
          }),
        ),
        Effect.provideService(BridgeSecureClient, secureClientWithAttestationStatus(frame.id)),
        Effect.provideService(BridgeAuditService, bridgeAuditService),
      ),
    );
    updateInferenceRequest(frame.id, {
      statusCode: response.status,
      ...readEhbpResponseEvidence(response.headers),
    });
    await storeRotatedSessionToken(response);
    notifyStatusChanged();

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Tinfoil secure request failed: ${response.status} ${errorMessage(body)}`);
    }

    yield {
      contentType: response.headers.get("content-type"),
      kind: "openai.response.start",
      status: response.status,
    };

    for await (const chunk of streamResponseBody(response)) {
      if (chunk.kind === "delta") {
        yield {
          data: chunk.value ?? "",
          kind: "openai.response.chunk",
        };
      } else if (chunk.kind === "error") {
        throw new Error(chunk.value ?? "Tinfoil secure response stream failed");
      }
    }

    audit.record("inference.forward_complete", {
      method: frame.method,
      path,
      requestId: frame.id,
    });
    completeInferenceStatus(frame.id, "completed");
    notifyStatusChanged();
  } catch (error) {
    if (abortController.signal.aborted) {
      audit.record("inference.forward_cancelled", {
        method: frame.method,
        path,
        requestId: frame.id,
      });
      completeInferenceStatus(frame.id, "cancelled");
      notifyStatusChanged();
      return;
    }

    const message = errorMessage(error);
    const safeMessage = safeStatusMessage(message);
    audit.record("inference.forward_failed", {
      message,
      method: frame.method,
      path,
      requestId: frame.id,
    });
    console.error("[bridge:inference] forward failed", {
      message: safeMessage,
      method: frame.method,
      path,
      requestId: frame.id,
    });
    failInferenceStatus(frame.id, message);
    notifyStatusChanged();
    throw error;
  } finally {
    activeInferenceRequests.delete(frame.id);
  }
}

async function forwardHandoffFeedbackAnalytics(frame: BridgeRequestFrame): Promise<JsonValue> {
  return forwardHandoffFeedback(frame.id, frame.payload, {
    audit,
    onUnauthorized: clearInvalidStoredSession,
    onResponse: storeRotatedSessionToken,
    readSession: () => sessionStore().read(),
    refreshSession: refreshInferenceSessionIfNeeded,
    serverBaseUrl,
  });
}

function cancelInference(frame: BridgeRequestFrame): JsonValue {
  const requestId =
    frame.payload
    && typeof frame.payload === "object"
    && !Array.isArray(frame.payload)
    && typeof frame.payload.requestId === "string"
      ? frame.payload.requestId
      : frame.id;
  const active = activeInferenceRequests.get(requestId);
  active?.abort();
  if (active) {
    completeInferenceStatus(requestId, "cancelled");
  }
  audit.record("inference.cancel_requested", { active: Boolean(active), requestId });
  return { cancelled: Boolean(active), requestId };
}

function unsupportedInferenceMethod(method: string): never {
  throw new Error(`${method} is not supported by the current server Tinfoil proxy.`);
}

async function refreshInferenceSessionIfNeeded(session: SignedInWorkOsSession): Promise<WorkOsSession> {
  if (!shouldRefreshWorkOsSession(session)) return session;
  return refreshStoredSession({ session });
}

async function refreshStoredSession(options: {
  readonly force?: boolean;
  readonly session?: SignedInWorkOsSession;
} = {}): Promise<WorkOsSession> {
  const session = options.session ?? await readSignedInSession();
  if (!session) return { kind: "signed_out" };
  if (!options.force && !shouldRefreshWorkOsSession(session)) return session;
  try {
    const authSession = await authServer.validateSession(session.sessionToken, options.force ? { forceRefresh: true } : undefined);
    const nextSession = toStoredSession(authSession, session);
    await sessionStore().write(nextSession);
    if (nextSession.sessionToken !== session.sessionToken) {
      audit.record("auth.session_refreshed", { userId: nextSession.user.id });
    }
    if (options.force) {
      audit.record("auth.session_force_refreshed", { userId: nextSession.user.id });
      notifyStatusChanged();
    }
    return nextSession;
  } catch (error) {
    const message = errorMessage(error);
    if (isInvalidStoredSessionError(error)) {
      await clearInvalidStoredSession(message);
      return { kind: "signed_out" };
    }
    audit.record("auth.session_refresh_failed", { message: safeStatusMessage(message) });
    throw error;
  }
}

async function clearInvalidStoredSession(reason: string): Promise<void> {
  await sessionStore().clear();
  authError = STALE_SESSION_MESSAGE;
  audit.record("auth.session_expired", { message: safeStatusMessage(reason) });
  notifyStatusChanged();
}

function isInvalidStoredSessionError(error: unknown): boolean {
  return error instanceof AuthServerRequestError && error.status === 401;
}

async function storeRotatedSessionToken(response: Response): Promise<void> {
  const sessionToken = response.headers.get(AMBIENT_SESSION_TOKEN_HEADER);
  if (!sessionToken) return;

  try {
    const authSession = await authServer.validateSession(sessionToken);
    const nextSession = toStoredSession(authSession, await readSignedInSession());
    await sessionStore().write(nextSession);
    audit.record("auth.session_rotation_stored", { userId: nextSession.user.id });
  } catch (error) {
    audit.record("auth.session_rotation_store_failed", {
      message: safeStatusMessage(errorMessage(error)),
    });
  }
}

async function localSessionPayload(): Promise<JsonValue> {
  const session = await sessionStore().read();
  if (session.kind === "signed_out") {
    return { kind: "signed_out" };
  }
  return {
    email: session.email,
    expiresAt: session.expiresAt,
    featureFlags: publicFeatureFlags(session),
    kind: "signed_in",
    organizationId: session.organizationId ?? null,
    organizationName: session.organizationName ?? null,
    user: {
      email: session.user.email,
      id: session.user.id,
      name: session.user.name,
    },
  };
}

async function integrationTokenPayload(): Promise<JsonValue> {
  const session = await sessionStore().read();
  if (session.kind === "signed_out") {
    throw new Error("Bridge is signed out.");
  }
  const { session: rotatedSession, ...delegated } = await authServer.createIntegrationToken(session.sessionToken);
  if (rotatedSession && rotatedSession.sessionToken !== session.sessionToken) {
    try {
      await sessionStore().write(toStoredSession(rotatedSession, session));
      audit.record("auth.session_rotation_stored", { userId: rotatedSession.user.id });
    } catch (error) {
      audit.record("auth.session_rotation_store_failed", {
        message: safeStatusMessage(errorMessage(error)),
      });
    }
  }
  audit.record("auth.integration_token_delegated", { expiresAt: delegated.expiresAt, scope: delegated.scope });
  // The session token never crosses the IPC boundary to the app.
  return delegated as unknown as JsonValue;
}

/**
 * Builds the stored session from a server auth response, carrying over the
 * organization directory (names + memberships) from the previously stored
 * session. Token refreshes rotate the sealed session but do not change
 * memberships, so the cached directory stays valid until the next explicit
 * organizations refresh.
 */
function toStoredSession(
  authSession: AuthBrokerSessionResponse,
  base?: SignedInWorkOsSession | null,
): SignedInWorkOsSession {
  const email = authSession.user.email ?? authSession.user.name ?? authSession.user.id;
  const organizations = base?.organizations;
  const organizationName = authSession.organizationId
    ? organizations?.find((org) => org.id === authSession.organizationId)?.name
      ?? (base?.organizationId === authSession.organizationId ? base?.organizationName : undefined)
    : undefined;
  return {
    email,
    expiresAt: authSession.expiresAt,
    featureFlags: sanitizeFeatureFlagSlugs(authSession.featureFlags),
    kind: "signed_in",
    organizationId: authSession.organizationId,
    organizationName,
    organizations,
    sessionToken: authSession.sessionToken,
    user: authSession.user,
  };
}

async function readSignedInSession(): Promise<SignedInWorkOsSession | null> {
  const session = await sessionStore().read();
  return session.kind === "signed_in" ? session : null;
}

async function signInViaIpc(): Promise<JsonValue> {
  const session = await readSignedInSession();
  if (session) {
    return { status: "already_signed_in" };
  }
  if (pendingLogin) {
    return { status: "login_pending" };
  }
  await startLoginFlow();
  return { status: "login_started" };
}

async function switchOrganization(organizationId: string): Promise<JsonValue> {
  const session = await readSignedInSession();
  if (!session) {
    throw new Error("Bridge is not signed in.");
  }
  if (session.organizationId === organizationId) {
    return { organizationId, status: "unchanged" };
  }

  try {
    const authSession = await authServer.switchOrganization(session.sessionToken, organizationId);
    await sessionStore().write(toStoredSession(authSession, session));
    audit.record("auth.organization_switched", { organizationId });
    notifyStatusChanged();
    void refreshOrganizations();
    return { organizationId, status: "switched" };
  } catch (error) {
    if (error instanceof AuthServerRequestError && error.status === 401) {
      // The org may require a fresh interactive grant (SSO/MFA). Send the user
      // through the browser flow scoped to that organization; the AuthKit
      // session cookie usually makes this a single redirect.
      audit.record("auth.organization_switch_reauth", { organizationId });
      await startLoginFlow({ organizationId });
      return { organizationId, status: "login_started" };
    }
    audit.record("auth.organization_switch_failed", {
      message: safeStatusMessage(errorMessage(error)),
      organizationId,
    });
    throw error;
  }
}

/**
 * Fetches the user's organization memberships from the server and persists
 * them on the stored session so the status payload (and both app UIs) can
 * render the org switcher without extra round-trips. Best-effort: callers
 * fire-and-forget; failures keep the previous directory.
 */
function refreshOrganizations(): Promise<void> {
  organizationsRefresh ??= refreshOrganizationsOnce()
    .catch((error) => {
      audit.record("auth.organizations_refresh_failed", {
        message: safeStatusMessage(errorMessage(error)),
      });
    })
    .finally(() => {
      organizationsRefresh = null;
    });
  return organizationsRefresh;
}

async function refreshOrganizationsOnce(): Promise<void> {
  const session = await readSignedInSession();
  if (!session) return;

  const response = await authServer.listOrganizations(session.sessionToken);
  // Re-read: the listing round-trip may have raced a refresh elsewhere.
  const current = await readSignedInSession();
  if (!current) return;

  const base = response.session ? toStoredSession(response.session, current) : current;
  const organizationId = response.organizationId ?? base.organizationId ?? null;
  await sessionStore().write({
    ...base,
    organizationId,
    organizationName: organizationId
      ? response.organizations.find((org) => org.id === organizationId)?.name ?? base.organizationName
      : undefined,
    organizations: response.organizations,
  });
  audit.record("auth.organizations_refreshed", { count: response.organizations.length });
  notifyStatusChanged();
}

async function organizationsPayload(): Promise<JsonValue> {
  let session = await readSignedInSession();
  if (!session) {
    throw new Error("Bridge is not signed in.");
  }
  if (!session.organizations) {
    await refreshOrganizations();
    session = (await readSignedInSession()) ?? session;
  }
  return {
    organizationId: session.organizationId ?? null,
    organizations: (session.organizations ?? []) as JsonValue,
  };
}

async function* statusSubscriptionStream(socketClosed?: Promise<void>): IpcStream {
  const queue = new LatestStatusQueue();
  const listener = () => queue.invalidate();
  let closed = false;
  void socketClosed?.then(() => {
    closed = true;
    queue.invalidate();
  });
  statusEvents.on("changed", listener);
  try {
    yield (await getStatus()) as unknown as JsonValue;
    while (!closed) {
      await queue.wait();
      if (closed) return;
      yield (await getStatus()) as unknown as JsonValue;
    }
  } finally {
    statusEvents.off("changed", listener);
  }
}

/**
 * Conflating signal for the status stream: any number of change events while
 * a snapshot is being produced collapse into one pending wake-up, so slow
 * consumers always converge on the latest status instead of a backlog.
 */
class LatestStatusQueue {
  private pending = false;
  private waiter: (() => void) | null = null;

  invalidate(): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve();
      return;
    }
    this.pending = true;
  }

  wait(): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

function publicAccountState(session: WorkOsSession): BridgeStatus["account"] {
  if (session.kind === "signed_out") {
    return session;
  }
  return {
    email: session.email,
    featureFlags: publicFeatureFlags(session),
    kind: "signed_in",
    name: session.user.name ?? undefined,
    profilePictureUrl: session.user.profilePictureUrl ?? undefined,
    organizationId: session.organizationId ?? undefined,
    organizationName: session.organizationName,
    organizations: session.organizations,
  };
}

function publicFeatureFlags(session: SignedInWorkOsSession): BridgeFeatureFlags {
  const enabledSlugs = sanitizeFeatureFlagSlugs(session.featureFlags);
  const capabilities = featureFlagCapabilities(enabledSlugs);
  return {
    capabilities,
    definitions: [...AMBIENT_FEATURE_FLAG_DEFINITIONS],
    enabledSlugs,
    evaluatedFor: {
      organizationId: session.organizationId ?? null,
      userId: session.user.id,
    },
    sample: {
      enabled: capabilities.devtooling,
      slug: "devtools-visible",
    },
    source: session.organizationId ? "organization" : "user",
  };
}

function featureFlagCapabilities(enabledSlugs: readonly string[]): BridgeFeatureFlagCapabilities {
  const enabled = new Set(enabledSlugs);
  const automations = enabled.has("automations-enabled");
  return {
    integrations: enabled.has("integrations-enabled"),
    automations,
    automationToggleTrack: automations && enabled.has("automations-toggle-track-available"),
    devtooling: enabled.has("devtools-visible"),
    contextHandoff: enabled.has("context-handoff-available"),
  };
}

function sanitizeFeatureFlagSlugs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((slug): slug is string => typeof slug === "string" && slug.trim().length > 0))]
    .sort();
}

function sessionStore(): EncryptedSessionStore {
  workOsSessionStore ??= new EncryptedSessionStore(join(app.getPath("userData"), "workos-session.enc"), safeStorage);
  return workOsSessionStore;
}

function initialUpdateStatus(): BridgeUpdateStatus {
  const reason = bridgeUpdaterUnavailableReason({
    arch: process.arch,
    isPackaged: app.isPackaged,
    platform: process.platform,
  });
  const feedUrl = reason
    ? null
    : bridgeUpdateFeedUrl({
        arch: process.arch,
        baseUrl: process.env.AMBIENT_BRIDGE_UPDATE_BASE_URL ?? serverBaseUrl,
        channel: releaseChannel,
      });
  return {
    channel: releaseChannel,
    checking: false,
    currentVersion: app.getVersion(),
    downloaded: false,
    downloading: false,
    enabled: reason === null,
    feedUrl,
    reason: reason ?? undefined,
    updateAvailable: false,
  };
}

function configureBridgeUpdater(): void {
  if (!updateStatus.enabled || !updateStatus.feedUrl || updateEventsRegistered) return;
  updateEventsRegistered = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({ provider: "generic", url: updateStatus.feedUrl });

  autoUpdater.on("checking-for-update", () => {
    setUpdateStatus({ checking: true, updateError: undefined });
  });
  autoUpdater.on("update-available", (info: { readonly version?: string }) => {
    setUpdateStatus({
      checking: false,
      downloading: true,
      latestVersion: info.version,
      updateAvailable: true,
      updateError: undefined,
    });
  });
  autoUpdater.on("update-not-available", (info: { readonly version?: string }) => {
    setUpdateStatus({
      checking: false,
      downloaded: false,
      downloading: false,
      latestVersion: info.version,
      updateAvailable: false,
      updateError: undefined,
    });
  });
  autoUpdater.on("download-progress", () => {
    setUpdateStatus({ downloading: true });
  });
  autoUpdater.on("update-downloaded", (info: { readonly version?: string }) => {
    setUpdateStatus({
      checking: false,
      downloaded: true,
      downloading: false,
      latestVersion: info.version,
      updateAvailable: true,
      updateError: undefined,
    });
  });
  autoUpdater.on("error", (error) => {
    setUpdateStatus({
      checking: false,
      downloading: false,
      updateError: errorMessage(error),
    });
  });
}

function getUpdateStatus(): BridgeUpdateStatus {
  return { ...updateStatus };
}

async function checkForBridgeUpdates(): Promise<BridgeUpdateStatus> {
  if (!updateStatus.enabled) return getUpdateStatus();
  configureBridgeUpdater();
  setUpdateStatus({ checking: true, updateError: undefined });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setUpdateStatus({ checking: false, downloading: false, updateError: errorMessage(error) });
  }
  return getUpdateStatus();
}

function installBridgeUpdate(): BridgeUpdateStatus {
  if (!updateStatus.enabled || !updateStatus.downloaded) return getUpdateStatus();
  autoUpdater.quitAndInstall(false, true);
  return getUpdateStatus();
}

function setUpdateStatus(next: Partial<BridgeUpdateStatus>): void {
  updateStatus = { ...updateStatus, ...next, currentVersion: app.getVersion() };
  notifyUpdateStatusChanged();
}

function notifyStatusChanged(): void {
  sendToMainWindow("bridge:status-changed");
  statusEvents.emit("changed");
}

function notifyUpdateStatusChanged(): void {
  sendToMainWindow("bridge:update-status-changed", getUpdateStatus());
}

function sendToMainWindow(channel: string, ...args: unknown[]): void {
  const webContents = liveMainWindow()?.webContents;
  if (!webContents || webContents.isDestroyed()) return;
  try {
    webContents.send(channel, ...args);
  } catch {
    // The renderer frame can be disposed (e.g. after a renderer crash) while
    // the window object is still alive; dropping the notification is fine —
    // the renderer re-reads status when it reloads.
  }
}

function showMainWindow(): void {
  const window = liveMainWindow();
  if (!window) return;
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

function liveMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}
