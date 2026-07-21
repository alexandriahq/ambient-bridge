import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { BridgeIpcServer, type IpcHandlerContext, type IpcStream } from "./ipc-server/socket.js";
import type { BridgeRequestFrame, JsonValue } from "./ipc-server/protocol.js";
import { PairingStore, type PairedClient, type PairingRequest, type PairingResult } from "./ipc-server/pairing.js";
import { signDescriptor, writeDescriptorFile } from "./ipc-server/descriptor.js";
import { createDeviceIdentity } from "./devices/identity.js";
import { CompositeAuditSink, FileAuditSink, MemoryAuditSink, RingAuditSink, type AuditEvent } from "./diagnostics/audit.js";
import { CrashRing, crashReportTelemetryProperties } from "@ambient/shared/observability";
import { excludeWindowFromSelfCapture } from "@ambient/shared/window-capture";
import { createBridgeCrashReportStore } from "./diagnostics/crash-report.js";
import { promptBridgeCrashReportConsent } from "./diagnostics/crash-report-window.js";
import { EncryptedSessionStore } from "./workos/token-store.js";
import { LocalSecretVault } from "./local-secret-vault.js";
import { clearBridgeUserQuitMarker, writeBridgeUserQuitMarker } from "./user-quit-marker.js";
import {
  shouldRefreshWorkOsSession,
  type WorkOsFeatureFlagsByOrganization,
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
  resolveServerBaseUrl,
  type AuthBrokerSessionResponse,
  type AuthOrganizationFeatureFlags,
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
import { forwardTelemetryBatch } from "./analytics/telemetry.js";
import {
  bridgeErrorTelemetryBatch,
  bridgeTelemetryBatch,
  bridgeTelemetryEnabled,
  createBridgeErrorForwardLimiter,
  type BridgeCrashOrigin,
} from "./diagnostics/crash-telemetry.js";
import { audioTranscriptionRequestFromPayload, audioUploadMetadataFromPayload } from "./inference/audio-transcription.js";
import { NetworkRequestHistory, readEhbpResponseEvidence, type NetworkRequestRecord } from "./inference/network-log.js";
import { WireTap } from "./inference/wire-tap.js";
import { closeCompactAuthWindow, showCompactAuthWindow } from "./compact-auth-window.js";
import {
  BridgeWindowLifecycleController,
  bridgeLoginItemSettings,
  bridgeLoginItemSettingsOptions,
  macBridgeActivationPolicy,
  resolveBridgeLaunchDecision,
  shouldHideMacDock,
  shouldOpenMainWindowOnLaunch,
} from "./window-lifecycle.js";
import {
  BRIDGE_RELEASE_DEFAULT_CHANNEL,
  BRIDGE_RELEASE_EXPERIMENTAL_CHANNEL,
  bridgeReleaseListUrl,
  bridgeUpdateBaseUrlFromEnv,
  bridgeUpdateFeedUrl,
  bridgeUpdaterUnavailableReason,
  bridgeVersionedUpdateFeedUrl,
  parseBridgeExperimentalBuildsResponse,
} from "./update-feed.js";
import {
  isHttpUrl,
  normalizeDownloadPercent,
  sanitizedUpdateDiagnostics,
} from "@ambient/shared/update-core";
import {
  ServerReachabilityMonitor,
  type ServerReachabilityReason,
  type ServerReachabilitySnapshot,
  type ServerReachabilityState,
} from "./reachability.js";
import { errorMessage } from "./error-message.js";
import { createBridgeShutdownCoordinator } from "./shutdown-coordinator.js";
import { inferenceRequestKey, InferenceRequestRegistry } from "./inference/request-registry.js";
import { registerBridgeWireCaptureIpc } from "./bridge-ui-ipc.js";
import type { BridgeWireCaptureResult } from "./bridge-ui-contract.js";
import {
  SessionRefreshCoordinator,
  isAuthProviderUnavailableError,
  isDefinitiveSessionRejection,
  resolveSessionRefreshFailure,
  sessionRefreshConnectionState,
  type SessionRefreshSnapshot,
} from "./session-refresh-coordinator.js";
import {
  BUILD_COMMIT_SHA,
  BUILD_RELEASE_CHANNEL,
} from "./generated/build-config.js";

const requireFromMain = createRequire(import.meta.url);
const { autoUpdater } = requireFromMain("electron-updater") as typeof import("electron-updater");
const APP_ID = "com.alexandria.ambient.bridge";
const BRIDGE_UI_E2E_REQUEST_ID = "bridge-e2e-wire-capture";
const BRIDGE_UI_E2E_REQUEST_BODY = "AQIDBAUGBwgJCgsMDQ4PEA==";

configureBridgeDevProfile();

function configureBridgeDevProfile(): void {
  const configured = process.env.AMBIENT_BRIDGE_DEV_PROFILE_DIR?.trim();
  if (app.isPackaged || !configured) return;
  const profileDir = resolve(configured);
  const appData = join(profileDir, "app-data");
  const userData = join(profileDir, "user-data");
  mkdirSync(appData, { recursive: true });
  mkdirSync(userData, { recursive: true });
  app.setPath("appData", appData);
  app.setPath("userData", userData);
}

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
  connection: "ready" | "starting" | "checking" | "retrying" | "degraded" | "proxy_unavailable" | "attestation_invalid" | "offline";
  inference: BridgeInferenceStatus;
  pairedClientList: BridgePairedClient[];
  pairedClients: number;
  pairingRequests: BridgePairingRequest[];
  runtimeIdentity: {
    channel: string;
    commitSha: string;
    serverUrl: string;
    version: string;
  };
  serverReachable: boolean;
  serverReachability: ServerReachabilityState;
  serverReachabilityCheckedAt: number | null;
  serverReachabilityHttpStatus: number | null;
  serverReachabilityMessage: string;
  serverReachabilityReason: ServerReachabilityReason;
  sessionRefresh: SessionRefreshSnapshot;
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
  wireCaptureRevision: number;
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
  releaseNotesUrl?: string | null;
  downloadPercent?: number | null;
  lastCheckedAtMs?: number;
  lastUpdatedAtMs?: number;
  updateAvailable: boolean;
  updateError?: string;
};

type PendingLogin = {
  callbackReturnUri: string;
  callbackServer?: HttpServer;
  callbackTimeout?: NodeJS.Timeout;
  clientState: string;
  organizationId?: string;
  showBridgeOnCompletion: boolean;
};

type SecureInferenceRequestOverrides = Pick<Parameters<typeof secureInferenceResponse>[0], "body" | "contentType" | "accept">;

const LOGIN_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const ATTESTATION_HISTORY_LIMIT = 10;
const SERVER_REACHABILITY_TTL_MS = 8_000;
const SERVER_REACHABILITY_TIMEOUT_MS = 2_500;
const IPC_SOCKET_HEALTH_INTERVAL_MS = 15_000;
// Proactive session-refresh retry budget. A stale access token gets renewed on
// launch (and when the server comes back online) before the first inference
// request; a transient WorkOS/network failure at boot is retried with backoff
// so auth self-heals instead of wedging until a manual sign-out and back in.
const SESSION_REFRESH_MAX_ATTEMPTS = 5;
const SESSION_REFRESH_BASE_DELAY_MS = 2_000;
const SESSION_REFRESH_MAX_DELAY_MS = 30_000;
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
if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}
// Chromium encrypts renderer cookies with OSCrypt, whose key lives in the
// login keychain as "<AppName> Safe Storage" — accessed on EVERY launch even
// though app code no longer uses safeStorage (see local-secret-vault.ts).
// Unsigned/ad-hoc builds change identity each build, so that access interrupts
// launch with a password prompt. The mock keychain keeps OSCrypt in-memory:
// no keychain access, no prompt; renderer cookies hold nothing sensitive
// (auth lives in the main-process vault).
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("use-mock-keychain");
}
// Chromium's native window occlusion tracker misclassifies visible windows as
// occluded on Windows and stops compositing them (black window, app still
// running). Confirmed on the Ambient app main window (#248/#253); Bridge uses
// the same window stack, so disable the feature here too. Must run before
// app ready.
if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

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

function resolveBridgeResourcePath(fileName: string): string | undefined {
  const sourceRoot = join(import.meta.dirname, "..", "..");
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, fileName),
        join(sourceRoot, "resources", fileName),
      ]
    : [
        join(sourceRoot, "resources", fileName),
        join(process.cwd(), "resources", fileName),
      ];
  return candidates.find((candidate) => existsSync(candidate));
}

function resolveBridgeWindowIconPath(): string | undefined {
  if (process.platform === "darwin") return undefined;
  const iconFile = process.platform === "win32" ? "bridge-icon.ico" : "bridge-icon-source.png";
  return resolveBridgeResourcePath(iconFile);
}

function createBridgeTrayImage(): Electron.NativeImage {
  if (process.platform === "darwin") {
    // Dedicated monochrome lock glyph: the "Template" filename makes Electron
    // mark it as a template image (and pick up the @2x sibling), so macOS
    // renders it correctly in light/dark menu bars. Resizing the full-color
    // app icon instead collapses to an illegible alpha blob.
    const templatePath = resolveBridgeResourcePath("bridge-tray-iconTemplate.png");
    if (templatePath) {
      const template = nativeImage.createFromPath(templatePath);
      if (!template.isEmpty()) return template;
    }
  }
  const iconFile = process.platform === "win32" ? "bridge-icon.ico" : "bridge-icon-source.png";
  const iconPath = resolveBridgeResourcePath(iconFile);
  const image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (process.platform !== "darwin" || image.isEmpty()) return image;

  const trayImage = image.resize({ height: 18, width: 18 });
  trayImage.setTemplateImage(true);
  return trayImage;
}

// Quiet tray/menu-bar status item used to reopen or quit the background Bridge.
let tray: Tray | undefined;
let trayMenu: Menu | undefined;
let pendingShowMainWindowReason: string | null = null;
let ipcServer: BridgeIpcServer | undefined;
let pendingLogin: PendingLogin | undefined;
let authError: string | undefined;
let workOsSessionStore: EncryptedSessionStore | undefined;
let organizationsRefresh: Promise<void> | null = null;
const statusEvents = new EventEmitter();
statusEvents.setMaxListeners(50);
let lastAuthStatusSnapshotSignature: string | null = null;

// Rolling 30s window of audit activity, persisted alongside crash markers so a
// Bridge crash report carries "what Bridge was doing" — same architecture as
// the Ambient app's crash ring.
const bridgeCrashRing = new CrashRing();
const audit = new CompositeAuditSink([
  new MemoryAuditSink(),
  new FileAuditSink(join(app.getPath("userData"), "logs", "bridge-audit.jsonl")),
  new RingAuditSink(bridgeCrashRing),
]);
const bridgeCrashReports = createBridgeCrashReportStore({
  dir: join(app.getPath("userData"), "crashes"),
  window: (nowMs) => ({
    text: bridgeCrashRing.snapshot(nowMs).text,
    summary: bridgeCrashRing.summary(nowMs),
  }),
});
let pairingStore = new PairingStore();
const identity = createDeviceIdentity();
const serverBaseUrl = resolveServerBaseUrl();
const activeInferenceRequests = new InferenceRequestRegistry();
const activeAttestationChecks = new Set<string>();
let inferenceGeneration = 0;
const networkHistory = new NetworkRequestHistory();
const wireTap = new WireTap({
  onEvict: () => {
    markWireCaptureChanged();
  },
  onUpdate: (requestId) => {
    networkHistory.patchLatestByRequestId(requestId, { wireCaptured: true });
    markWireCaptureChanged();
  },
});
wireTap.install();
const bridgeAuditService = createBridgeAuditService(audit);
// Every inference request demands attestation: the secure client verifies the
// enclave through the ambient-server's attestation pass-through before any sealed
// body leaves this device. There is no unattested route.
const bridgeSecureClient = createBridgeSecureClient({ serverBaseUrl });
let inferenceStatus: BridgeInferenceStatus = initialInferenceStatus();
const authServer = new AuthServerClient({ baseUrl: serverBaseUrl });
const sessionRefreshCoordinator = new SessionRefreshCoordinator<SignedInWorkOsSession>({
  errorMessage: (error) => safeStatusMessage(errorMessage(error)),
  onRetryExhausted: ({ attempt, delayMs, message, reason }) => {
    audit.record("auth.session_refresh_retry_exhausted", {
      attempts: attempt,
      message,
      nextRetryDelayMs: delayMs,
      reason,
    });
  },
  onRetryScheduled: ({ attempt, delayMs, message, reason }) => {
    audit.record("auth.session_refresh_retry_scheduled", { attempt, delayMs, message, reason });
  },
  onStateChange: (snapshot) => {
    audit.record("auth.session_refresh_state_changed", {
      attempt: snapshot.attempt,
      nextRetryAt: snapshot.nextRetryAt,
      state: snapshot.state,
    });
    notifyStatusChanged();
  },
  policy: {
    baseDelayMs: SESSION_REFRESH_BASE_DELAY_MS,
    maxAttempts: SESSION_REFRESH_MAX_ATTEMPTS,
    maxDelayMs: SESSION_REFRESH_MAX_DELAY_MS,
    recoveryDelayMs: SESSION_REFRESH_MAX_DELAY_MS,
  },
  readSession: readSignedInSession,
  refreshSession: async (session) => {
    await refreshStoredSession({ session });
  },
});
const releaseChannel = process.env.AMBIENT_BRIDGE_RELEASE_CHANNEL ?? BUILD_RELEASE_CHANNEL;
let updateStatus = initialUpdateStatus();
let updateEventsRegistered = false;
let updateAuditSignature: string | null = null;
const serverReachability = new ServerReachabilityMonitor({
  onReachabilityChange: (reachable, snapshot) => {
    audit.record("server.reachability_changed", {
      checkedAt: snapshot.checkedAt,
      httpStatus: snapshot.httpStatus ?? null,
      reachable,
      reason: snapshot.reason,
    });
    // The server (and by extension WorkOS) is reachable again after an outage.
    // Renew a stale session now so auth recovers on its own, rather than
    // leaving the next inference request to fail with "Auth provider
    // unavailable" until the user manually signs out and back in.
    if (reachable) void refreshStoredSessionResilient("server_reachable");
  },
  onStateChange: notifyStatusChanged,
  probe: () => authServer.checkHealthDetailed({
    timeoutMs: SERVER_REACHABILITY_TIMEOUT_MS,
  }),
  ttlMs: SERVER_REACHABILITY_TTL_MS,
});

const windowLifecycle = new BridgeWindowLifecycleController({
  activateApp: activateBridgeAppForUser,
  createWindow: createMainWindow,
  deactivateApp: () => {
    // Return focus/menu bar to the previously active app; without this the
    // hidden accessory app keeps "Ambient Bridge" in the menu bar.
    if (process.platform === "darwin") app.hide();
  },
  destroyTray,
  onStateChange: (state) => {
    audit.record("lifecycle.state_changed", {
      authWindow: state.authWindow,
      mainWindow: state.mainWindow,
      quitting: state.quitting,
      services: state.services,
    });
  },
  platform: process.platform,
  quitApp: () => {
    // Explicit user quit (tray/menu/Cmd+Q): leave a marker so the Ambient
    // app's auto-launcher does not immediately restart Bridge. OS shutdowns
    // and update restarts bypass this path on purpose.
    try {
      writeBridgeUserQuitMarker(bridgeIpcSupportDir());
    } catch (error) {
      audit.record("lifecycle.user_quit_marker_failed", { message: safeStatusMessage(errorMessage(error)) });
    }
    app.quit();
  },
});

const shutdownCoordinator = createBridgeShutdownCoordinator({
  abortActiveInference: () => {
    activeInferenceRequests.abortAll("bridge_shutdown");
  },
  beforeShutdown: () => {
    sessionRefreshCoordinator.dispose();
    windowLifecycle.prepareForQuit();
    closeAuthCompactWindow();
    closePendingLoginCallback();
  },
  exit: (exitCode) => app.exit(exitCode),
  flushAudit: () => audit.flush(),
  onFailure: (error) => {
    audit.record("lifecycle.shutdown_failed", { message: safeStatusMessage(errorMessage(error)) });
  },
  stopIpcServer: async () => {
    const server = ipcServer;
    ipcServer = undefined;
    await server?.stop();
  },
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  void handleAuthCallback(url);
});

app.on("open-file", (event) => {
  event.preventDefault();
  requestShowMainWindow("open_file");
});

app.on("activate", () => {
  if (!app.isReady()) return;
  requestShowMainWindow("activate");
});

async function createMainWindow(): Promise<BrowserWindow> {
  // Follow the system appearance (matches the Ambient app). The renderer
  // ships light + dark palettes via prefers-color-scheme in styles.css.
  nativeTheme.themeSource = "system";

  const preload = join(import.meta.dirname, "preload.cjs");
  const icon = resolveBridgeWindowIconPath();
  const useMacWindowChrome = process.platform === "darwin";
  const window = new BrowserWindow({
    height: 900,
    minHeight: 560,
    minWidth: 860,
    autoHideMenuBar: process.platform !== "darwin",
    backgroundColor: useMacWindowChrome ? "#00000000" : "#ffffff",
    ...(icon ? { icon } : {}),
    show: false,
    skipTaskbar: process.platform === "win32",
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
    width: 1440,
  });

  excludeWindowFromSelfCapture(window);

  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("[bridge] renderer process gone", details);
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[bridge] renderer failed to load", { errorCode, errorDescription, validatedURL });
  });

  await loadBridgeRenderer(window);

  if (process.env.AMBIENT_BRIDGE_OPEN_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" });
  }

  return window;
}

// Canonical renderer entry for the Bridge main window: the dev server when
// running unpackaged, otherwise the packaged index.html.
function loadBridgeRenderer(window: BrowserWindow): Promise<void> {
  if (process.env.VITE_DEV_SERVER_URL) {
    console.log(`[bridge] loading renderer dev server ${process.env.VITE_DEV_SERVER_URL}`);
    return window.loadURL(process.env.VITE_DEV_SERVER_URL);
  }
  const rendererPath = join(import.meta.dirname, "../renderer/index.html");
  console.log(`[bridge] loading packaged renderer ${rendererPath}`);
  return window.loadFile(rendererPath);
}

function requestShowMainWindow(reason: string): void {
  if (!app.isReady()) {
    pendingShowMainWindowReason = reason;
    return;
  }
  void showMainWindowNow(reason);
}

async function showMainWindowNow(reason: string): Promise<void> {
  try {
    await windowLifecycle.showMainWindow();
    audit.record("lifecycle.window_shown", { reason });
  } catch (error) {
    console.error("[bridge] failed to show main window", errorMessage(error));
    audit.record("lifecycle.window_show_failed", { message: safeStatusMessage(errorMessage(error)), reason });
  }
}

function applyBridgeBackgroundPresentation(): void {
  if (process.platform !== "darwin") return;
  try {
    app.setActivationPolicy(macBridgeActivationPolicy());
  } catch (error) {
    audit.record("lifecycle.activation_policy_failed", { message: safeStatusMessage(errorMessage(error)) });
  }
  if (shouldHideMacDock(process.platform) && app.dock) {
    app.dock.hide();
  }
}

function activateBridgeAppForUser(): void {
  if (process.platform !== "darwin") return;
  // Never reassert the accessory policy / dock.hide() here: that macOS
  // process-type transform hides the app's windows, so every reveal path
  // (tray Show, Spotlight/Raycast reopen, activate) flashed the window and
  // immediately hid it again. The policy is applied once at startup and
  // nothing reverts it. app.show() undoes the app.hide() from the hide path.
  app.show();
  app.focus({ steal: true });
}

function configureApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { label: `Show ${APP_NAME}`, accelerator: "Command+O", click: () => showMainWindow() },
        { label: "Hide Window", accelerator: "Command+W", click: () => windowLifecycle.hideMainWindow() },
        { type: "separator" },
        { label: `Quit ${APP_NAME}`, accelerator: "Command+Q", click: () => windowLifecycle.requestQuit() },
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Create a quiet tray/menu-bar icon so Bridge remains reachable after its
// window is hidden. Clicking the icon reopens the window on all tray-capable
// desktop platforms; the menu (right-click on macOS, context menu elsewhere)
// exposes explicit Show, Open at Login, and Quit paths.
function setupTray(): void {
  if (process.platform !== "win32" && process.platform !== "darwin" && process.platform !== "linux") return;
  if (tray && !tray.isDestroyed()) return;

  const image = createBridgeTrayImage();
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip(APP_NAME);
  updateTrayMenu();

  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
  if (process.platform === "darwin") {
    // setContextMenu would swallow click events on macOS, leaving the icon
    // seemingly dead; the menu lives on right-click instead.
    tray.on("right-click", () => {
      if (tray && !tray.isDestroyed() && trayMenu) tray.popUpContextMenu(trayMenu);
    });
  }
}

function updateTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return;
  trayMenu = Menu.buildFromTemplate([
    { label: `Show ${APP_NAME}`, click: () => showMainWindow() },
    {
      checked: bridgeOpenAtLogin(),
      click: (menuItem) => setBridgeOpenAtLogin(menuItem.checked),
      label: "Open at Login",
      type: "checkbox",
    },
    { type: "separator" },
    { label: "Quit", click: () => windowLifecycle.requestQuit() },
  ]);
  if (process.platform !== "darwin") {
    tray.setContextMenu(trayMenu);
  }
}

function bridgeOpenAtLogin(): boolean {
  try {
    const settings = getBridgeLoginItemSettings();
    return Boolean(settings.openAtLogin || settings.executableWillLaunchAtLogin);
  } catch (error) {
    audit.record("lifecycle.login_item_read_failed", { message: safeStatusMessage(errorMessage(error)) });
    return false;
  }
}

function setBridgeOpenAtLogin(openAtLogin: boolean): void {
  try {
    app.setLoginItemSettings(bridgeLoginItemSettings({
      execPath: process.execPath,
      openAtLogin,
      platform: process.platform,
    }));
    const settings = getBridgeLoginItemSettings();
    audit.record("lifecycle.login_item_updated", {
      openAtLogin: settings.openAtLogin,
      requestedOpenAtLogin: openAtLogin,
      status: settings.status ?? null,
    });
  } catch (error) {
    audit.record("lifecycle.login_item_update_failed", {
      message: safeStatusMessage(errorMessage(error)),
      requestedOpenAtLogin: openAtLogin,
    });
  } finally {
    updateTrayMenu();
  }
}

function getBridgeLoginItemSettings(): Electron.LoginItemSettings {
  const options = bridgeLoginItemSettingsOptions({ execPath: process.execPath, platform: process.platform });
  return options ? app.getLoginItemSettings(options) : app.getLoginItemSettings();
}

function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = undefined;
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
      "bridge.status": async (frame) => getStatus({
        forceRefreshReachability: payloadBoolean(frame.payload, "refreshReachability"),
        forceRefreshSession: payloadBoolean(frame.payload, "refreshSession"),
      }),
      "bridge.statusSubscribe": (_frame, context) => statusSubscriptionStream(context.socketClosed),
      "auth.integrationToken": async () => integrationTokenPayload(),
      "auth.session": async () => localSessionPayload(),
      "auth.cancelSignIn": async () => cancelSignInViaIpc(),
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
        return switchOrganization(organizationId, { compactWindow: false });
      },
      "auth.organizations": async () => organizationsPayload(),
      "analytics.handoffFeedback": async (frame) => forwardHandoffFeedbackAnalytics(frame),
      "analytics.telemetryBatch": async (frame) => forwardTelemetryBatchAnalytics(frame),
      "inference.audioSpeech": async () => unsupportedInferenceMethod("inference.audioSpeech"),
      "inference.audioTranscriptions": (frame, context) => forwardAudioTranscription(frame, context),
      "inference.chatCompletions": (frame, context) => forwardInference(frame, context, "/v1/chat/completions"),
      "inference.embeddings": async () => unsupportedInferenceMethod("inference.embeddings"),
      "inference.responses": (frame, context) => forwardInference(frame, context, "/v1/responses"),
      "inference.cancel": async (frame, context) => cancelInference(frame, context),
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

async function getStatus(options: {
  readonly forceRefreshReachability?: boolean;
  readonly forceRefreshSession?: boolean;
} = {}): Promise<BridgeStatus> {
  if (options.forceRefreshSession) {
    await refreshStoredSessionDirect("forced_status", { force: true });
    await refreshOrganizations();
  }
  const [session, reachability, socketReady] = await Promise.all([
    sessionStore().read(),
    currentServerReachability({ force: options.forceRefreshReachability === true }),
    ensureIpcSocketAlive(),
  ]);
  const account = pendingLogin
    ? { kind: "login_pending" as const }
    : publicAccountState(bridgeUiE2eWireUrl() ? bridgeUiE2eSession() : session);
  const e2eFixture = bridgeUiE2eWireUrl() !== null;
  const serverReachable = e2eFixture || reachability.state === "reachable";
  const sessionRefresh = sessionRefreshCoordinator.snapshot();

  const status: BridgeStatus = {
    account,
    activity: recentActivity(),
    appVersion: app.getVersion(),
    authError,
    connection: e2eFixture
      ? "ready"
      : connectionState({ reachability: reachability.state, sessionRefresh, socketReady }),
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
    runtimeIdentity: {
      channel: BUILD_RELEASE_CHANNEL,
      commitSha: BUILD_COMMIT_SHA,
      serverUrl: new URL(serverBaseUrl).origin,
      version: app.getVersion(),
    },
    serverReachable,
    serverReachability: e2eFixture ? "reachable" : reachability.state,
    serverReachabilityCheckedAt: reachability.checkedAt,
    serverReachabilityHttpStatus: reachability.httpStatus ?? null,
    serverReachabilityMessage: e2eFixture ? "Local Bridge Electron test endpoint is reachable." : reachability.message,
    serverReachabilityReason: e2eFixture ? "ok" : reachability.reason,
    sessionRefresh,
    socketReady,
  };
  recordAuthStatusSnapshot(status.account, options.forceRefreshSession ? "force_refresh" : "read");
  return status;
}

function currentServerReachability(options: { readonly force?: boolean } = {}): Promise<ServerReachabilitySnapshot> | ServerReachabilitySnapshot {
  return options.force ? serverReachability.refresh() : serverReachability.current();
}

function connectionState(input: {
  reachability: ServerReachabilityState;
  sessionRefresh: SessionRefreshSnapshot;
  socketReady: boolean;
}): BridgeStatus["connection"] {
  if (!input.socketReady) return "starting";
  if (input.reachability === "checking") return "checking";
  if (input.reachability === "unavailable") return "proxy_unavailable";
  return sessionRefreshConnectionState(input.sessionRefresh);
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

function recordAuthStatusSnapshot(account: BridgeAccountState, reason: string): void {
  const signature = authStatusSnapshotSignature(account);
  if (signature === lastAuthStatusSnapshotSignature) return;
  lastAuthStatusSnapshotSignature = signature;

  if (account.kind !== "signed_in") {
    audit.record("auth.status_snapshot", {
      accountKind: account.kind,
      reason,
    });
    return;
  }

  const enabledSlugs = sanitizeFeatureFlagSlugs(account.featureFlags.enabledSlugs);
  audit.record("auth.status_snapshot", {
    accountKind: account.kind,
    featureFlagCount: enabledSlugs.length,
    featureFlagSlugs: enabledSlugs.join(","),
    featureFlagSource: account.featureFlags.source,
    featureFlagsOrganizationId: account.featureFlags.evaluatedFor.organizationId,
    organizationId: account.organizationId ?? null,
    organizationName: account.organizationName ?? null,
    reason,
    userId: account.featureFlags.evaluatedFor.userId,
  });
}

function authStatusSnapshotSignature(account: BridgeAccountState): string {
  if (account.kind !== "signed_in") return account.kind;
  return [
    account.kind,
    account.organizationId ?? "",
    account.organizationName ?? "",
    account.featureFlags.source,
    account.featureFlags.evaluatedFor.userId,
    account.featureFlags.evaluatedFor.organizationId ?? "",
    sanitizeFeatureFlagSlugs(account.featureFlags.enabledSlugs).join(","),
  ].join("|");
}

ipcMain.handle("bridge:get-status", () => getStatus());
ipcMain.handle("bridge:retry-reachability", () => getStatus({ forceRefreshReachability: true }));
ipcMain.handle("bridge:get-update-status", () => getUpdateStatus());
registerBridgeWireCaptureIpc(ipcMain, {
  captures: { get: bridgeWireCaptureResult },
  writeClipboardText: (value) => clipboard.writeText(value),
});

function bridgeWireCaptureResult(requestId: string): BridgeWireCaptureResult {
  const capture = wireTap.get(requestId);
  if (capture) return { capture, state: "available" };
  const request = networkHistory.get(requestId);
  if (!request) return { state: "not_captured" };
  if (request.wireCaptured) return { state: "evicted" };
  return { state: request.status === "active" ? "pending" : "not_captured" };
}

function bridgeUiE2eWireUrl(): string | null {
  if (app.isPackaged || process.env.AMBIENT_BRIDGE_E2E !== "1") return null;
  const configured = process.env.AMBIENT_BRIDGE_E2E_WIRE_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return url.protocol === "http:" && loopback ? url.toString() : null;
  } catch {
    return null;
  }
}

function bridgeUiE2eSession(): WorkOsSession {
  return {
    email: "bridge-electron-e2e@example.invalid",
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    featureFlags: ["devtools-visible"],
    kind: "signed_in",
    organizationId: "org-bridge-electron-e2e",
    organizationName: "Bridge Electron E2E",
    organizations: [{ id: "org-bridge-electron-e2e", name: "Bridge Electron E2E" }],
    sessionToken: "bridge-electron-e2e-session",
    user: {
      email: "bridge-electron-e2e@example.invalid",
      id: "user-bridge-electron-e2e",
      name: "Bridge Electron E2E",
    },
  };
}

async function seedBridgeUiE2eWireCapture(): Promise<void> {
  const url = bridgeUiE2eWireUrl();
  if (!url) return;
  const body = Buffer.from(BRIDGE_UI_E2E_REQUEST_BODY, "base64");
  const startedAt = Date.now();
  networkHistory.start({
    attestation: "verified",
    feature: "electron-runtime-test",
    model: "bridge-electron-e2e",
    path: "/v1/responses",
    requestBytes: body.byteLength,
    requestId: BRIDGE_UI_E2E_REQUEST_ID,
    startedAt,
  });
  const response = await fetch(url, {
    body,
    headers: {
      "authorization": "Bearer bridge-electron-e2e-redacted",
      "content-type": "application/ehbp",
      "ehbp-encapsulated-key": "bridge-electron-e2e-encapsulated-key",
      "x-ambient-request-id": BRIDGE_UI_E2E_REQUEST_ID,
    },
    method: "POST",
  });
  const deadline = Date.now() + 2_000;
  while (!wireTap.get(BRIDGE_UI_E2E_REQUEST_ID)?.response && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const capture = wireTap.get(BRIDGE_UI_E2E_REQUEST_ID);
  if (!capture?.response) {
    throw new Error("Bridge Electron E2E wire capture did not complete.");
  }
  networkHistory.patch(BRIDGE_UI_E2E_REQUEST_ID, {
    completedAt: Date.now(),
    status: "completed",
    statusCode: response.status,
    wireCaptured: true,
    ...readEhbpResponseEvidence(response.headers),
  });
  inferenceStatus = {
    ...inferenceStatus,
    attestation: "verified",
    attestationChecks: [{
      checkedAt: startedAt,
      reason: null,
      requestId: BRIDGE_UI_E2E_REQUEST_ID,
      status: "passed",
    }],
  };
  notifyStatusChanged();
}

ipcMain.handle("bridge:check-for-updates", async () => checkForBridgeUpdates());

// Cross-channel check mirroring the app's check-stable: experimental Bridge
// builds still learn about newer stable-channel releases.
ipcMain.handle("bridge:check-stable-updates", async () => checkForBridgeUpdatesFromFeed({
  allowDowngrade: true,
  channel: BRIDGE_RELEASE_DEFAULT_CHANNEL,
}));

ipcMain.handle("bridge:install-update", () => installBridgeUpdate());

ipcMain.handle("bridge:view-update-release-notes", () => openBridgeUpdateReleaseNotes());

ipcMain.handle("bridge:experimental-builds", () => listExperimentalBridgeBuilds());

ipcMain.handle("bridge:install-experimental", (_event, version: unknown) => installExperimentalBridgeBuild(version));

async function startLoginFlow(options: { organizationId?: string; compactWindow?: boolean } = {}): Promise<void> {
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
    organizationId: options.organizationId,
    showBridgeOnCompletion: options.compactWindow !== false,
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
  if (options.compactWindow !== false) await showAuthPendingCompactWindow();
  try {
    await shell.openExternal(loginUrl);
  } catch (error) {
    closePendingLoginCallback();
    if (options.compactWindow !== false) {
      closeAuthCompactWindow();
      showMainWindow();
    }
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
  closeAuthCompactWindow();
  authError = undefined;
  clearInferenceTransparency();
  await store.clear();
  audit.record("auth.sign_out", {});
  notifyStatusChanged();
}

function cancelPendingLogin(reason: string): boolean {
  const login = pendingLogin;
  if (!login) return false;
  clearLoginResources(login);
  pendingLogin = undefined;
  authError = undefined;
  audit.record("auth.login_cancelled", { reason });
  notifyStatusChanged();
  return true;
}

function cancelSignInViaIpc(): JsonValue {
  const cancelled = cancelPendingLogin("ambient_ipc");
  return { status: cancelled ? "cancelled" : "idle" };
}

function cancelAuthFromCompactWindow(): void {
  cancelPendingLogin("compact_window");
  closeAuthCompactWindow();
  showMainWindow();
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
app.on("second-instance", (_event, argv) => {
  const decision = resolveBridgeLaunchDecision({ argv, env: process.env });
  audit.record("lifecycle.second_instance", { mode: decision.mode, reason: decision.reason });
  if (shouldOpenMainWindowOnLaunch(decision)) {
    showMainWindow();
  }
});

app.whenReady().then(async () => {
  console.log("[bridge] app ready");
  // Any Bridge start (manual or auto) revokes a previous explicit quit.
  try {
    clearBridgeUserQuitMarker(bridgeIpcSupportDir());
  } catch (error) {
    audit.record("lifecycle.user_quit_marker_clear_failed", { message: safeStatusMessage(errorMessage(error)) });
  }
  configureApplicationMenu();
  applyDevDockIcon();
  applyBridgeBackgroundPresentation();
  setupTray();
  if (!useLoopbackAuthCallback()) {
    registerAuthCallbackProtocol();
  }
  pairingStore = new PairingStore();
  await startIpcServer();
  await seedBridgeUiE2eWireCapture();
  const socketHealthTimer = setInterval(() => {
    void ensureIpcSocketAlive();
  }, IPC_SOCKET_HEALTH_INTERVAL_MS);
  socketHealthTimer.unref?.();
  configureBridgeUpdater();
  // Renew a stale WorkOS session on launch (with retry) so the first inference
  // request doesn't fail with "Auth provider unavailable" when the stored
  // access token expired while the app was closed. Refill the organization
  // directory afterwards, using the freshened token, so org switching works
  // without waiting for the first sign-in or token refresh.
  void refreshStoredSessionResilient("startup").finally(() => {
    void refreshOrganizations();
  });
  const launchDecision = resolveBridgeLaunchDecision({
    argv: process.argv,
    env: process.env,
    loginItemSettings: getBridgeLoginItemSettings(),
  });
  audit.record("lifecycle.launch", { mode: launchDecision.mode, reason: launchDecision.reason });
  const pendingShowReason = pendingShowMainWindowReason;
  pendingShowMainWindowReason = null;
  if (pendingShowReason) {
    await showMainWindowNow(pendingShowReason);
  } else if (shouldOpenMainWindowOnLaunch(launchDecision)) {
    await showMainWindowNow("initial_launch");
  }
  recordBridgeLaunchTelemetry();
  void maybePromptPendingBridgeCrashReports().catch((error) => {
    audit.record("crash.report_flow_failed", { message: safeStatusMessage(errorMessage(error)) });
  });
  armDevCrashTrigger();
}).catch((error) => {
  console.error("[bridge] startup failed", error);
  app.exit(1);
});

/**
 * Testing hook for the whole crash pipeline: with AMBIENT_DEV_CRASH_AFTER_MS
 * set, the Bridge main process throws an uncaught exception after that many
 * ms — exercising the real snapshot → marker → reopen-consent → telemetry flow
 * with no code edit, in dev and packaged builds alike. Inert unless the env
 * var is explicitly set to a valid delay.
 */
function armDevCrashTrigger(): void {
  const raw = process.env.AMBIENT_DEV_CRASH_AFTER_MS?.trim();
  if (!raw) return;
  const delayMs = Number(raw);
  if (!Number.isFinite(delayMs) || delayMs < 0) return;
  audit.record("process.dev_crash_trigger_armed", { delayMs });
  setTimeout(() => {
    throw new Error(`dev crash trigger fired after ${delayMs}ms (AMBIENT_DEV_CRASH_AFTER_MS)`);
  }, delayMs);
}

app.on("window-all-closed", () => {
  // Bridge is a background utility: hidden/closed windows must not stop the IPC
  // server, descriptor, auth/session refresh, proxy, diagnostics, or updater.
});

app.on("before-quit", (event) => {
  shutdownCoordinator.handleBeforeQuit(event);
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

    clearInferenceTransparency();
    await sessionStore().write(toStoredSession(authSession));
    // A request could have started with the old cached session while the new
    // encrypted session was being written. Advance the boundary again only
    // after replacement is durable so that work cannot survive re-auth.
    clearInferenceTransparency();
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
  if (login?.showBridgeOnCompletion) showMainWindow();
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
  const login = pendingLogin;
  if (!login || login.clientState !== clientState) return;
  clearLoginResources(login);
  pendingLogin = undefined;
  authError = "Sign-in timed out waiting for the browser callback. Check that the server is reachable and try again.";
  console.error("[bridge:auth] login timed out waiting for callback");
  audit.record("auth.login_timeout", {});
  notifyStatusChanged();
  if (login.showBridgeOnCompletion) showMainWindow();
}

async function showAuthPendingCompactWindow(): Promise<void> {
  try {
    const window = await windowLifecycle.showMainWindow() as BrowserWindow;
    showCompactAuthWindow({
      appName: APP_NAME,
      anchorWindow: window,
      detail: "Continue in your browser",
      onCancel: cancelAuthFromCompactWindow,
      onRestore: showMainWindow,
      onRestoreLoadFailed: (failedWindow) => {
        console.error("[bridge:auth] compact auth restore URL failed to load; reloading renderer entry");
        void loadBridgeRenderer(failedWindow).catch(() => undefined);
      },
    });
    windowLifecycle.markAuthWindowVisible();
  } catch (error) {
    windowLifecycle.markAuthWindowHidden();
    console.error("[bridge:auth] failed to show compact sign-in window", errorMessage(error));
  }
}

function closeAuthCompactWindow(): void {
  closeCompactAuthWindow();
  windowLifecycle.markAuthWindowHidden();
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
    wireCaptureRevision: 0,
  };
}

function markWireCaptureChanged(): void {
  inferenceStatus = {
    ...inferenceStatus,
    wireCaptureRevision: inferenceStatus.wireCaptureRevision + 1,
  };
  notifyStatusChanged();
}

function startInferenceStatus(
  frame: BridgeRequestFrame,
  path: InferenceProxyPath,
  requestBytes: number | null,
  statusKey = frame.id,
): void {
  inferenceStatus = { ...inferenceStatus, lastError: null };
  const model = payloadString(frame.payload, "model");
  networkHistory.start({
    feature: frame.method,
    model,
    path,
    requestBytes,
    requestId: frame.id,
    startedAt: Date.now(),
  }, statusKey);
  notifyStatusChanged();
}

function beginInferenceAttestationCheck(statusKey: string, generation: number): void {
  if (generation !== inferenceGeneration) return;
  activeAttestationChecks.add(statusKey);
  inferenceStatus = {
    ...inferenceStatus,
    attestation: inferenceStatus.attestation === "verified" ? "verified" : "verifying",
    attestationInProgress: true,
  };
  networkHistory.patch(statusKey, { attestation: "pending" });
  notifyStatusChanged();
}

function completeInferenceAttestationCheck(statusKey: string, requestId: string, generation: number): void {
  if (generation !== inferenceGeneration) return;
  activeAttestationChecks.delete(statusKey);
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
  networkHistory.patch(statusKey, { attestation: "verified" });
  notifyStatusChanged();
}

function failInferenceAttestationCheck(
  statusKey: string,
  requestId: string,
  reason: string,
  generation: number,
): void {
  if (generation !== inferenceGeneration) return;
  activeAttestationChecks.delete(statusKey);
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
  networkHistory.patch(statusKey, { attestation: "failed" });
  notifyStatusChanged();
}

function recentAttestationChecks(nextCheck: BridgeAttestationCheck): BridgeAttestationCheck[] {
  return [
    nextCheck,
    ...inferenceStatus.attestationChecks.filter((check) => check.requestId !== nextCheck.requestId),
  ].slice(0, ATTESTATION_HISTORY_LIMIT);
}

function secureClientWithAttestationStatus(
  statusKey: string,
  requestId: string,
  generation: number,
): BridgeSecureClientShape {
  return {
    fetch: bridgeSecureClient.fetch,
    ready: () =>
      Effect.sync(() => beginInferenceAttestationCheck(statusKey, generation)).pipe(
        Effect.flatMap(() => bridgeSecureClient.ready()),
        Effect.tap(() => Effect.sync(() => completeInferenceAttestationCheck(statusKey, requestId, generation))),
        Effect.tapError((error) => Effect.sync(() => failInferenceAttestationCheck(
          statusKey,
          requestId,
          errorMessage(error),
          generation,
        ))),
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
  generation = inferenceGeneration,
): void {
  if (generation !== inferenceGeneration) return;
  updateInferenceRequest(requestId, {
    completedAt: Date.now(),
    status,
  });
  notifyStatusChanged();
}

function failInferenceStatus(requestId: string, message: string, generation: number): void {
  if (generation !== inferenceGeneration) return;
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

function forwardInference(frame: BridgeRequestFrame, context: IpcHandlerContext, path: InferenceProxyPath): IpcStream {
  const credentialId = authenticatedCredentialId(context);
  const statusKey = inferenceRequestKey(credentialId, frame.id);
  const abortController = new AbortController();
  const generation = inferenceGeneration;
  activeInferenceRequests.register({ controller: abortController, credentialId, requestId: frame.id, socketClosed: context.socketClosed });
  startInferenceStatus(frame, path, jsonPayloadByteLength(frame.payload), statusKey);
  return inferenceResponseStream(frame, path, credentialId, statusKey, abortController, undefined, generation);
}

function forwardAudioTranscription(frame: BridgeRequestFrame, context: IpcHandlerContext): IpcStream {
  const credentialId = authenticatedCredentialId(context);
  const statusKey = inferenceRequestKey(credentialId, frame.id);
  const abortController = new AbortController();
  const generation = inferenceGeneration;
  const path: InferenceProxyPath = "/v1/audio/transcriptions";
  activeInferenceRequests.register({ controller: abortController, credentialId, requestId: frame.id, socketClosed: context.socketClosed });
  const metadata = audioUploadMetadataFromPayload(frame.payload);
  startInferenceStatus(frame, path, metadata.expectedByteLength, statusKey);
  return inferenceResponseStream(
    frame,
    path,
    credentialId,
    statusKey,
    abortController,
    prepareAudioTranscriptionRequest(frame, context, metadata),
    generation,
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
  credentialId: string,
  statusKey: string,
  abortController: AbortController,
  request?: SecureInferenceRequestOverrides | Promise<SecureInferenceRequestOverrides>,
  generation = inferenceGeneration,
): IpcStream {
  audit.record("inference.forward_start", {
    method: frame.method,
    path,
    requestId: frame.id,
  });

  try {
    const preparedRequest = await request;
    if (generation !== inferenceGeneration) return;
    const response = await Effect.runPromise(
      secureInferenceResponse({
        appVersion: app.getVersion(),
        feature: frame.method,
        path,
        payload: frame.payload,
        ...preparedRequest,
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
        Effect.provideService(
          BridgeSecureClient,
          secureClientWithAttestationStatus(statusKey, frame.id, generation),
        ),
        Effect.provideService(BridgeAuditService, bridgeAuditService),
      ),
    );
    if (generation !== inferenceGeneration) return;
    updateInferenceRequest(statusKey, {
      responseHeadersAt: Date.now(),
      statusCode: response.status,
      ...readEhbpResponseEvidence(response.headers),
    });
    await storeRotatedSessionToken(response);
    if (generation !== inferenceGeneration) return;
    notifyStatusChanged();

    if (!response.ok) {
      const statusText = response.statusText.trim();
      throw new Error(`Tinfoil secure request failed: ${response.status}${statusText ? ` ${statusText}` : ""}`);
    }

    yield {
      contentType: response.headers.get("content-type"),
      kind: "openai.response.start",
      status: response.status,
    };

    let firstChunkObserved = false;
    for await (const chunk of streamResponseBody(response)) {
      if (generation !== inferenceGeneration) return;
      if (chunk.kind === "delta") {
        if (!firstChunkObserved) {
          firstChunkObserved = true;
          updateInferenceRequest(statusKey, { firstChunkAt: Date.now() });
        }
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
    completeInferenceStatus(statusKey, "completed", generation);
  } catch (error) {
    if (abortController.signal.aborted) {
      audit.record("inference.forward_cancelled", {
        method: frame.method,
        path,
        requestId: frame.id,
      });
      completeInferenceStatus(statusKey, "cancelled", generation);
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
    failInferenceStatus(statusKey, message, generation);
    if (generation === inferenceGeneration) notifyStatusChanged();
    throw error;
  } finally {
    activeInferenceRequests.release(credentialId, frame.id, abortController);
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

async function forwardTelemetryBatchAnalytics(frame: BridgeRequestFrame): Promise<JsonValue> {
  return forwardTelemetryBatch(frame.id, frame.payload, {
    audit,
    onUnauthorized: clearInvalidStoredSession,
    onResponse: storeRotatedSessionToken,
    readSession: () => sessionStore().read(),
    refreshSession: refreshInferenceSessionIfNeeded,
    serverBaseUrl,
  });
}

const bridgeErrorForwardAllowed = createBridgeErrorForwardLimiter();

function bridgeTelemetryForwardOptions() {
  return {
    audit,
    onUnauthorized: clearInvalidStoredSession,
    onResponse: storeRotatedSessionToken,
    readSession: () => sessionStore().read(),
    refreshSession: refreshInferenceSessionIfNeeded,
    serverBaseUrl,
  };
}

/**
 * Last-resort handler for Bridge process errors. Always audits locally
 * (bridge-audit.jsonl); a fatal exception additionally persists a crash marker
 * + 30s window (driving the next-launch consent prompt) and forwards a
 * sanitized crash signature to hosted telemetry when signed in, rate-limited so
 * a rejection storm cannot flood the server. Never rethrows — diagnostics must
 * not take Bridge down.
 */
function recordBridgeProcessError(origin: BridgeCrashOrigin, error: unknown): void {
  try {
    audit.record(
      origin === "uncaughtException" ? "process.uncaught_exception" : "process.unhandled_rejection",
      { message: safeStatusMessage(errorMessage(error)) },
    );
    if (origin === "uncaughtException") {
      const marker = bridgeCrashReports.writeSnapshotSync({
        origin,
        error,
        appVersion: app.getVersion(),
        platform: process.platform,
      });
      if (marker) audit.record("crash.snapshot_written", { crashId: marker.id });
    }
    if (!bridgeTelemetryEnabled() || !bridgeErrorForwardAllowed()) return;
    const batch = bridgeErrorTelemetryBatch({
      origin,
      error,
      appVersion: app.getVersion(),
      platform: process.platform,
    });
    void forwardTelemetryBatch(`bridge_err_${randomUUID()}`, batch, bridgeTelemetryForwardOptions())
      .catch(() => undefined);
  } catch {
    // Nothing else we can safely do while handling a process-level error.
  }
}

/**
 * Record one lifecycle event per launch so hosted analytics can relate Bridge
 * crash reports to launch volume (crash rate) — mirrors the Ambient app's
 * ambient.main.appLaunched. Must run before the pending-crash prompt consumes
 * the on-disk markers.
 */
function recordBridgeLaunchTelemetry(): void {
  try {
    const pending = bridgeCrashReports.listPending();
    if (!bridgeTelemetryEnabled()) return;
    const batch = bridgeTelemetryBatch({
      eventName: "bridge.main.appLaunched",
      severity: "info",
      status: "success",
      appVersion: app.getVersion(),
      platform: process.platform,
      properties: {
        previousCrashPending: pending.length > 0,
        previousCrashOrigin: pending[0]?.origin ?? null,
        launchToReadyMs: Math.round(process.uptime() * 1_000),
      },
    });
    void forwardTelemetryBatch(`bridge_launch_${randomUUID()}`, batch, bridgeTelemetryForwardOptions())
      .catch(() => undefined);
  } catch {
    // Launch telemetry is best-effort.
  }
}

/** On startup, offer to send any crash report left behind by a previous run. */
async function maybePromptPendingBridgeCrashReports(): Promise<void> {
  if (!bridgeTelemetryEnabled()) return;
  const pending = bridgeCrashReports.listPending();
  if (pending.length === 0) return;
  const [latest, ...older] = pending;
  // Only surface the most recent crash; discard older ones to avoid prompt spam.
  for (const stale of older) bridgeCrashReports.delete(stale.id);
  try {
    const consent = await promptBridgeCrashReportConsent(latest, (message) => {
      audit.record("crash.consent_window_failed", { message: safeStatusMessage(message) });
    });
    if (consent.send) {
      const batch = bridgeTelemetryBatch({
        eventName: "bridge.main.crashReport",
        severity: "fatal",
        status: "failure",
        appVersion: app.getVersion(),
        platform: process.platform,
        properties: crashReportTelemetryProperties(latest, {
          note: consent.note,
          reportedAtMs: Date.now(),
          logWindowIncluded: consent.includeLogs,
        }),
        exception: {
          type: latest.exception.type,
          message: latest.exception.message,
          stack: latest.exception.stack,
          handled: true,
        },
      });
      const result = await forwardTelemetryBatch(`bridge_crash_${latest.id}`, batch, bridgeTelemetryForwardOptions());
      audit.record("crash.report_submitted", { accepted: result.accepted, crashId: latest.id, ok: result.ok });
    } else {
      audit.record("crash.report_declined", { crashId: latest.id });
    }
  } catch (error) {
    audit.record("crash.report_flow_failed", { crashId: latest.id, message: safeStatusMessage(errorMessage(error)) });
  } finally {
    bridgeCrashReports.delete(latest.id);
  }
}

process.on("uncaughtException", (error) => {
  recordBridgeProcessError("uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  recordBridgeProcessError("unhandledRejection", reason);
});

function cancelInference(frame: BridgeRequestFrame, context: IpcHandlerContext): JsonValue {
  const credentialId = authenticatedCredentialId(context);
  const requestId =
    frame.payload
    && typeof frame.payload === "object"
    && !Array.isArray(frame.payload)
    && typeof frame.payload.requestId === "string"
      ? frame.payload.requestId
      : frame.id;
  const cancelled = activeInferenceRequests.cancel(credentialId, requestId);
  if (cancelled) {
    completeInferenceStatus(inferenceRequestKey(credentialId, requestId), "cancelled");
  }
  audit.record("inference.cancel_requested", { active: cancelled, requestId });
  return { cancelled, requestId };
}

function authenticatedCredentialId(context: IpcHandlerContext): string {
  if (!context.credentialId) throw new Error("Authenticated IPC client context is required.");
  return context.credentialId;
}

function unsupportedInferenceMethod(method: string): never {
  throw new Error(`${method} is not supported by the current server Tinfoil proxy.`);
}

async function refreshInferenceSessionIfNeeded(session: SignedInWorkOsSession): Promise<WorkOsSession> {
  if (!shouldRefreshWorkOsSession(session)) return session;
  return await refreshStoredSessionDirect("inference_session", { session });
}

/**
 * Proactively bring the stored session up to date, retrying transient failures
 * with exponential backoff. `refreshStoredSession` is a no-op when the token is
 * still valid, clears the session outright on a definitive 401, and re-throws
 * only the transient (503 / network) failures we retry here — so this either
 * quietly succeeds, cleanly signs the user out, or keeps trying until the
 * server recovers. Single-flighted so overlapping triggers (startup and the
 * reachability hook) share one refresh instead of racing the refresh token.
 */
function refreshStoredSessionResilient(reason: string): Promise<void> {
  return sessionRefreshCoordinator.refresh(reason);
}

async function refreshStoredSessionDirect(
  reason: string,
  options: {
    readonly force?: boolean;
    readonly session?: SignedInWorkOsSession;
  },
): Promise<WorkOsSession> {
  try {
    const refreshedSession = await refreshStoredSession(options);
    sessionRefreshCoordinator.markReady();
    return refreshedSession;
  } catch (error) {
    if (isAuthProviderUnavailableError(error)) {
      sessionRefreshCoordinator.noteTransientFailure(error, reason);
    }
    throw error;
  }
}

async function refreshStoredSession(options: {
  readonly force?: boolean;
  readonly session?: SignedInWorkOsSession;
} = {}): Promise<WorkOsSession> {
  const session = options.session ?? await readSignedInSession();
  if (!session) return { kind: "signed_out" };
  if (!options.force && !shouldRefreshWorkOsSession(session)) return session;
  try {
    const previousAuthStatusSignature = authStatusSnapshotSignature(publicAccountState(session));
    const authSession = await authServer.validateSession(session.sessionToken, options.force ? { forceRefresh: true } : undefined);
    const nextSession = withCachedCurrentOrganizationFeatureFlags(
      toStoredSession(authSession, session),
      { overwrite: true },
    );
    const nextAuthStatusSignature = authStatusSnapshotSignature(publicAccountState(nextSession));
    const authStatusChanged = nextAuthStatusSignature !== previousAuthStatusSignature;
    const wrote = await writeSignedInSessionIfCurrent(nextSession, session, "session_refresh");
    if (!wrote) return sessionStore().read();
    recordSessionFeatureFlags("auth.session_feature_flags_received", nextSession, {
      forced: Boolean(options.force),
      sessionTokenRotated: nextSession.sessionToken !== session.sessionToken,
    });
    if (nextSession.sessionToken !== session.sessionToken) {
      audit.record("auth.session_refreshed", { userId: nextSession.user.id });
    }
    if (!options.force && authStatusChanged) {
      audit.record("auth.session_status_changed", { reason: "session_refresh", userId: nextSession.user.id });
    }
    if (options.force) {
      audit.record("auth.session_force_refreshed", { userId: nextSession.user.id });
    }
    if (options.force || authStatusChanged) {
      notifyStatusChanged();
    }
    return nextSession;
  } catch (error) {
    const message = errorMessage(error);
    const disposition = await resolveSessionRefreshFailure(error, {
      clearSession: async () => clearInvalidStoredSession(message, session),
      isDefinitiveRejection: isDefinitiveSessionRejection,
    });
    if (disposition === "signed_out") {
      return { kind: "signed_out" };
    }
    if (disposition === "stale") {
      return sessionStore().read();
    }
    audit.record("auth.session_refresh_failed", { message: safeStatusMessage(message) });
    throw error;
  }
}

async function clearInvalidStoredSession(
  reason: string,
  expectedSession: SignedInWorkOsSession,
): Promise<boolean> {
  const cleared = await sessionStore().clearIfCurrent(expectedSession);
  if (!cleared) {
    audit.record("auth.session_clear_skipped", {
      reason: "session_changed",
      userId: expectedSession.user.id,
    });
    return false;
  }

  clearInferenceTransparency();
  authError = STALE_SESSION_MESSAGE;
  audit.record("auth.session_expired", { message: safeStatusMessage(reason) });
  notifyStatusChanged();
  return true;
}

async function storeRotatedSessionToken(response: Response): Promise<void> {
  const sessionToken = response.headers.get(AMBIENT_SESSION_TOKEN_HEADER);
  if (!sessionToken) return;

  try {
    const current = await readSignedInSession();
    if (!current) return;
    const authSession = await authServer.validateSession(sessionToken);
    const nextSession = withCachedCurrentOrganizationFeatureFlags(
      toStoredSession(authSession, current),
      { overwrite: true },
    );
    const wrote = await writeSignedInSessionIfCurrent(nextSession, current, "session_rotation");
    if (!wrote) return;
    recordSessionFeatureFlags("auth.session_rotation_feature_flags_received", nextSession);
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
      const nextSession = toStoredSession(rotatedSession, session);
      const wrote = await writeSignedInSessionIfCurrent(nextSession, session, "integration_token_rotation");
      if (wrote) {
        recordSessionFeatureFlags("auth.session_rotation_feature_flags_received", nextSession);
        audit.record("auth.session_rotation_stored", { userId: rotatedSession.user.id });
      }
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
  const featureFlags = sanitizeFeatureFlagSlugs(authSession.featureFlags);
  const organizationName = authSession.organizationId
    ? organizations?.find((org) => org.id === authSession.organizationId)?.name
      ?? (base?.organizationId === authSession.organizationId ? base?.organizationName : undefined)
    : undefined;
  return {
    email,
    expiresAt: authSession.expiresAt,
    featureFlags,
    featureFlagsByOrganization: base?.featureFlagsByOrganization,
    kind: "signed_in",
    organizationId: authSession.organizationId,
    organizationName,
    organizations,
    sessionToken: authSession.sessionToken,
    user: authSession.user,
  };
}

async function readBackSwitchedOrganizationSession(
  authSession: AuthBrokerSessionResponse,
  organizationId: string,
  startedAt: number,
): Promise<AuthBrokerSessionResponse> {
  try {
    const refreshed = await authServer.validateSession(authSession.sessionToken, {
      forceRefresh: true,
      organizationId,
    });
    recordAuthBrokerFeatureFlags("auth.organization_switch_readback_feature_flags_received", refreshed, {
      elapsedMs: Date.now() - startedAt,
      sessionTokenRotated: refreshed.sessionToken !== authSession.sessionToken,
    });
    return refreshed;
  } catch (error) {
    audit.record("auth.organization_switch_readback_failed", {
      elapsedMs: Date.now() - startedAt,
      message: safeStatusMessage(errorMessage(error)),
      organizationId,
    });
    return authSession;
  }
}

function withCachedCurrentOrganizationFeatureFlags(
  session: SignedInWorkOsSession,
  options: { readonly overwrite: boolean },
): SignedInWorkOsSession {
  const organizationId = session.organizationId ?? null;
  if (!organizationId) return session;
  if (!options.overwrite && hasOwnFeatureFlagsForOrganization(session.featureFlagsByOrganization, organizationId)) {
    return session;
  }

  return {
    ...session,
    featureFlagsByOrganization: mergeFeatureFlagsByOrganization(
      session.featureFlagsByOrganization,
      [{ featureFlags: sanitizeFeatureFlagSlugs(session.featureFlags), organizationId }],
    ),
  };
}

function recordAuthBrokerFeatureFlags(
  name: string,
  authSession: AuthBrokerSessionResponse,
  fields: AuditEvent["fields"] = {},
): void {
  const slugs = sanitizeFeatureFlagSlugs(authSession.featureFlags);
  audit.record(name, {
    ...fields,
    featureFlagCount: slugs.length,
    featureFlagSlugs: slugs.join(","),
    organizationId: authSession.organizationId ?? null,
    userId: authSession.user.id,
  });
}

function recordSessionFeatureFlags(
  name: string,
  session: SignedInWorkOsSession,
  fields: AuditEvent["fields"] = {},
): void {
  const sessionSlugs = sanitizeFeatureFlagSlugs(session.featureFlags);
  const resolvedSlugs = sessionFeatureFlagSlugs(session);
  audit.record(name, {
    ...fields,
    featureFlagCount: sessionSlugs.length,
    featureFlagOrganizationCount: Object.keys(session.featureFlagsByOrganization ?? {}).length,
    featureFlagResolution: sessionFeatureFlagResolution(session),
    featureFlagSlugs: sessionSlugs.join(","),
    organizationId: session.organizationId ?? null,
    resolvedFeatureFlagCount: resolvedSlugs.length,
    resolvedFeatureFlagSlugs: resolvedSlugs.join(","),
    userId: session.user.id,
  });
}

async function readSignedInSession(): Promise<SignedInWorkOsSession | null> {
  const session = await sessionStore().read();
  return session.kind === "signed_in" ? session : null;
}

async function writeSignedInSessionIfCurrent(
  nextSession: SignedInWorkOsSession,
  expectedSession: SignedInWorkOsSession,
  reason: string,
): Promise<boolean> {
  const result = await sessionStore().writeIfCurrent(nextSession, expectedSession);
  if (result !== "written") {
    audit.record("auth.session_write_skipped", {
      reason,
      state: result,
      userId: expectedSession.user.id,
    });
    return false;
  }

  return true;
}

async function signInViaIpc(): Promise<JsonValue> {
  const session = await readSignedInSession();
  if (session) {
    return { status: "already_signed_in" };
  }
  await startLoginFlow({ compactWindow: false });
  return { status: "login_started" };
}

async function switchOrganization(
  organizationId: string,
  options: { readonly compactWindow?: boolean } = {},
): Promise<JsonValue> {
  const session = await readSignedInSession();
  if (!session) {
    throw new Error("Bridge is not signed in.");
  }
  if (session.organizationId === organizationId) {
    return { organizationId, status: "unchanged" };
  }

  try {
    const startedAt = Date.now();
    audit.record("auth.organization_switch_started", {
      fromOrganizationId: session.organizationId ?? null,
      organizationId,
    });
    const baseSession = withCachedCurrentOrganizationFeatureFlags(session, { overwrite: false });
    const authSession = await authServer.switchOrganization(session.sessionToken, organizationId);
    recordAuthBrokerFeatureFlags("auth.organization_switch_response_feature_flags_received", authSession, {
      elapsedMs: Date.now() - startedAt,
    });
    const refreshedAuthSession = await readBackSwitchedOrganizationSession(authSession, organizationId, startedAt);
    const nextSession = toStoredSession(refreshedAuthSession, baseSession);
    const wrote = await writeSignedInSessionIfCurrent(nextSession, session, "organization_switch");
    if (!wrote) {
      notifyStatusChanged();
      return { organizationId, status: "stale" };
    }
    clearInferenceTransparency();
    recordSessionFeatureFlags("auth.organization_switch_feature_flags_received", nextSession, {
      elapsedMs: Date.now() - startedAt,
    });
    await refreshOrganizations();
    audit.record("auth.organization_switched", {
      elapsedMs: Date.now() - startedAt,
      organizationId,
    });
    notifyStatusChanged();
    return { organizationId, status: "switched" };
  } catch (error) {
    if (error instanceof AuthServerRequestError && error.status === 401) {
      // The org may require a fresh interactive grant (SSO/MFA). Send the user
      // through the browser flow scoped to that organization; the AuthKit
      // session cookie usually makes this a single redirect.
      audit.record("auth.organization_switch_reauth", { organizationId });
      await startLoginFlow({ compactWindow: options.compactWindow, organizationId });
      return { organizationId, status: "login_started" };
    }
    audit.record("auth.organization_switch_failed", {
      message: safeStatusMessage(errorMessage(error)),
      organizationId,
    });
    throw error;
  }
}

function clearInferenceTransparency(): void {
  inferenceGeneration += 1;
  activeInferenceRequests.abortAll("inference_boundary_changed");
  activeAttestationChecks.clear();
  networkHistory.clear();
  wireTap.clear();
  inferenceStatus = initialInferenceStatus();
  notifyStatusChanged();
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

  const response = await authServer.listOrganizations(session.sessionToken, { includeFeatureFlags: true });
  // Re-read: the listing round-trip may have raced a refresh elsewhere.
  const current = await readSignedInSession();
  if (!current) return;

  const base = response.session ? toStoredSession(response.session, current) : current;
  const organizationId = response.organizationId ?? base.organizationId ?? null;
  const featureFlagsByOrganization = mergeFeatureFlagsByOrganization(
    base.featureFlagsByOrganization,
    response.featureFlagsByOrganization,
  );
  const nextSession = {
    ...base,
    featureFlagsByOrganization,
    organizationId,
    organizationName: organizationId
      ? response.organizations.find((org) => org.id === organizationId)?.name ?? base.organizationName
      : undefined,
    organizations: response.organizations,
  };
  const wrote = await writeSignedInSessionIfCurrent(nextSession, current, "organizations_refresh");
  if (!wrote) return;
  audit.record("auth.organizations_refreshed", {
    activeOrganizationId: organizationId,
    count: response.organizations.length,
    featureFlagOrganizationCount: Object.keys(featureFlagsByOrganization ?? {}).length,
    featureFlagSummary: featureFlagSummary(featureFlagsByOrganization),
  });
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
  const enabledSlugs = sessionFeatureFlagSlugs(session);
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

function sessionFeatureFlagSlugs(session: SignedInWorkOsSession): string[] {
  const organizationId = session.organizationId ?? null;
  if (organizationId && hasOwnFeatureFlagsForOrganization(session.featureFlagsByOrganization, organizationId)) {
    return sanitizeFeatureFlagSlugs(session.featureFlagsByOrganization?.[organizationId]);
  }
  return sanitizeFeatureFlagSlugs(session.featureFlags);
}

function sessionFeatureFlagResolution(session: SignedInWorkOsSession): string {
  const organizationId = session.organizationId ?? null;
  if (!organizationId) return "user_session";
  if (hasOwnFeatureFlagsForOrganization(session.featureFlagsByOrganization, organizationId)) {
    return "organization_cache";
  }
  return "session_fallback";
}

function featureFlagSummary(featureFlagsByOrganization: WorkOsFeatureFlagsByOrganization | undefined): string {
  return Object.entries(featureFlagsByOrganization ?? {})
    .slice(0, 20)
    .map(([organizationId, featureFlags]) => {
      const slugs = sanitizeFeatureFlagSlugs(featureFlags);
      return `${organizationId}:${slugs.join(",")}`;
    })
    .join(";");
}

function mergeFeatureFlagsByOrganization(
  base: WorkOsFeatureFlagsByOrganization | undefined,
  entries: readonly AuthOrganizationFeatureFlags[],
): WorkOsFeatureFlagsByOrganization | undefined {
  const merged: Record<string, string[]> = {};
  for (const [organizationId, featureFlags] of Object.entries(base ?? {})) {
    if (!organizationId) continue;
    merged[organizationId] = sanitizeFeatureFlagSlugs(featureFlags);
  }
  for (const entry of entries) {
    if (!entry.organizationId) continue;
    merged[entry.organizationId] = sanitizeFeatureFlagSlugs(entry.featureFlags);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function hasOwnFeatureFlagsForOrganization(
  featureFlagsByOrganization: WorkOsFeatureFlagsByOrganization | undefined,
  organizationId: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(featureFlagsByOrganization ?? {}, organizationId);
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
  // Local vault instead of safeStorage: keychain-backed encryption interrupts
  // launch with a password prompt whenever the build's code signature changes
  // (unsigned/ad-hoc builds — every build). Sessions sealed by an old identity
  // fail to decrypt and read as signed_out, which is the pre-existing fallback.
  workOsSessionStore ??= new EncryptedSessionStore(
    join(app.getPath("userData"), "workos-session.enc"),
    new LocalSecretVault(join(app.getPath("userData"), "bridge-vault-key.json")),
  );
  return workOsSessionStore;
}

function initialUpdateStatus(): BridgeUpdateStatus {
  return bridgeUpdateStatusForFeed({ channel: releaseChannel });
}

function bridgeUpdateStatusForFeed(input: { readonly channel: string; readonly version?: string }): BridgeUpdateStatus {
  const reason = bridgeUpdaterUnavailableReason({
    arch: process.arch,
    isPackaged: app.isPackaged,
    localQaBuild: isLocalQaBuild(),
    platform: process.platform,
  });
  const baseUrl = bridgeUpdateBaseUrlFromEnv();
  const feedUrl = reason
    ? null
    : input.version
      ? bridgeVersionedUpdateFeedUrl({
        arch: process.arch,
        baseUrl,
        channel: input.channel,
        platform: process.platform,
        version: input.version,
      })
      : bridgeUpdateFeedUrl({
        arch: process.arch,
        baseUrl,
        channel: input.channel,
        platform: process.platform,
      });
  const releaseNotesUrl = reason
    ? null
    : bridgeReleaseListUrl({
      arch: process.arch,
      baseUrl,
      channel: input.channel,
      platform: process.platform,
    });
  return {
    channel: input.channel,
    checking: false,
    currentVersion: app.getVersion(),
    downloaded: false,
    downloadPercent: null,
    downloading: false,
    enabled: reason === null,
    feedUrl,
    latestVersion: input.version,
    reason: reason ?? undefined,
    releaseNotesUrl,
    lastUpdatedAtMs: Date.now(),
    updateAvailable: false,
  };
}

function isLocalQaBuild(): boolean {
  if (!app.isPackaged) return false;
  // dev.ps1 and dev.sh pin local installer versions to X.Y.Z-local.<timestamp>,
  // so the version alone identifies a local build even if the extraMetadata flag
  // is dropped from the build invocation again (regressed once in 5145131).
  if (app.getVersion().includes("-local.")) return true;
  try {
    const metadata = requireFromMain(join(app.getAppPath(), "package.json")) as { readonly ambientLocalQaBuild?: unknown };
    return metadata.ambientLocalQaBuild === true;
  } catch {
    return false;
  }
}

function configureBridgeUpdater(options: { readonly allowDowngrade?: boolean } = {}): void {
  if (!updateStatus.enabled || !updateStatus.feedUrl) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = options.allowDowngrade === true;
  autoUpdater.setFeedURL({ channel: updateStatus.channel, provider: "generic", url: updateStatus.feedUrl });
  registerBridgeUpdaterEvents();
}

function registerBridgeUpdaterEvents(): void {
  if (updateEventsRegistered) return;
  updateEventsRegistered = true;

  autoUpdater.on("checking-for-update", () => {
    setUpdateStatus({ checking: true, downloadPercent: null, lastCheckedAtMs: Date.now(), updateError: undefined });
  });
  autoUpdater.on("update-available", (info: { readonly version?: string }) => {
    setUpdateStatus({
      checking: false,
      downloadPercent: null,
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
      downloadPercent: null,
      downloading: false,
      latestVersion: info.version,
      updateAvailable: false,
      updateError: undefined,
    });
  });
  autoUpdater.on("download-progress", (progress: { readonly percent?: number }) => {
    setUpdateStatus({ downloading: true, downloadPercent: normalizeDownloadPercent(progress.percent) });
  });
  autoUpdater.on("update-downloaded", (info: { readonly version?: string }) => {
    setUpdateStatus({
      checking: false,
      downloaded: true,
      downloadPercent: 100,
      downloading: false,
      latestVersion: info.version,
      updateAvailable: true,
      updateError: undefined,
    });
  });
  autoUpdater.on("error", (error) => {
    setUpdateStatus({
      checking: false,
      downloadPercent: null,
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
  setUpdateStatus({ checking: true, downloadPercent: null, lastCheckedAtMs: Date.now(), updateError: undefined });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setUpdateStatus({ checking: false, downloadPercent: null, downloading: false, updateError: errorMessage(error) });
  }
  return getUpdateStatus();
}

const EXPERIMENTAL_BUILDS_FETCH_TIMEOUT_MS = 15_000;

async function checkForBridgeUpdatesFromFeed(input: {
  readonly allowDowngrade?: boolean;
  readonly channel: string;
  readonly version?: string;
}): Promise<BridgeUpdateStatus> {
  updateStatus = bridgeUpdateStatusForFeed(input);
  notifyUpdateStatusChanged();
  if (!updateStatus.enabled) return getUpdateStatus();
  configureBridgeUpdater({ allowDowngrade: input.allowDowngrade });
  setUpdateStatus({ checking: true, downloadPercent: null, lastCheckedAtMs: Date.now(), updateError: undefined });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setUpdateStatus({ checking: false, downloadPercent: null, downloading: false, updateError: errorMessage(error) });
  }
  return getUpdateStatus();
}

async function listExperimentalBridgeBuilds() {
  const channel = BRIDGE_RELEASE_EXPERIMENTAL_CHANNEL;
  const releasesUrl = bridgeReleaseListUrl({
    arch: process.arch,
    baseUrl: bridgeUpdateBaseUrlFromEnv(),
    channel,
    platform: process.platform,
  });
  const response = await fetch(releasesUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(EXPERIMENTAL_BUILDS_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Experimental build list request failed (${response.status}).`);
  }
  const body = await response.json() as unknown;
  return parseBridgeExperimentalBuildsResponse({
    arch: process.arch,
    body,
    channel,
    currentVersion: app.getVersion(),
    platform: process.platform,
    releasesUrl,
  });
}

async function installExperimentalBridgeBuild(identifierInput: unknown): Promise<BridgeUpdateStatus> {
  if (typeof identifierInput !== "string" || identifierInput.length === 0 || identifierInput.length > 360) {
    throw new Error("Invalid experimental build selection.");
  }

  const builds = await listExperimentalBridgeBuilds();
  const byStableKey = builds.builds.find((build) => build.releaseKey === identifierInput || build.id === identifierInput);
  const byVersion = builds.builds.filter((build) => build.version === identifierInput);
  if (!byStableKey && byVersion.length > 1) {
    throw new Error("Multiple experimental builds share that version. Refresh and choose the exact build row.");
  }
  const selected = byStableKey ?? byVersion[0];
  if (!selected) throw new Error("The selected experimental build is not available for this device.");

  return checkForBridgeUpdatesFromFeed({
    allowDowngrade: true,
    channel: BRIDGE_RELEASE_EXPERIMENTAL_CHANNEL,
    version: selected.version,
  });
}

async function openBridgeUpdateReleaseNotes(): Promise<boolean> {
  const url = updateStatus.releaseNotesUrl;
  if (!url || !isHttpUrl(url)) return false;
  await shell.openExternal(url);
  return true;
}

function installBridgeUpdate(): BridgeUpdateStatus {
  if (!updateStatus.enabled || !updateStatus.downloaded) return getUpdateStatus();
  windowLifecycle.prepareForQuit();
  autoUpdater.quitAndInstall(false, true);
  return getUpdateStatus();
}

function setUpdateStatus(next: Partial<BridgeUpdateStatus>): void {
  updateStatus = { ...updateStatus, ...next, currentVersion: app.getVersion(), lastUpdatedAtMs: Date.now() };
  recordUpdateStatusAudit(updateStatus);
  notifyUpdateStatusChanged();
}

function recordUpdateStatusAudit(status: BridgeUpdateStatus): void {
  const signature = [
    status.channel,
    status.currentVersion,
    status.latestVersion ?? "",
    status.downloaded,
    status.downloading,
    status.updateAvailable,
    status.updateError ?? "",
    typeof status.downloadPercent === "number" ? Math.round(status.downloadPercent / 10) * 10 : "",
  ].join("|");
  if (signature === updateAuditSignature) return;
  updateAuditSignature = signature;
  audit.record("update.status", sanitizedUpdateDiagnostics(status));
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
  closeAuthCompactWindow();
  requestShowMainWindow("show_main_window");
}

function liveMainWindow(): BrowserWindow | null {
  return windowLifecycle.liveWindow() as BrowserWindow | null;
}
