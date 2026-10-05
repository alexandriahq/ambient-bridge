import { usageTopupCheckoutRequestSchema } from "@ambient/shared/usage";
import { LoginStartGate } from './auth/login-start-gate.js';
import { LoopbackLoginListener, type LoginCallbackOutcome } from './auth/loopback-listener.js';
import {
  AMBIENT_FEATURE_FLAG_DEFINITIONS,
  assistantFeatureCapabilities,
  sanitizeFeatureFlagSlugs,
  type FeatureFlagDefinition as BridgeFeatureFlagDefinition,
  type FeatureFlagCapabilities as BridgeFeatureFlagCapabilities,
} from "@ambient/shared/feature-flags";

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
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { BridgeStatusClock } from "./bridge-status-clock.js";

import { Effect } from "effect";
import { BridgeIpcServer, type IpcHandlerContext, type IpcMethodHandler, type IpcStream } from "./ipc-server/socket.js";
import type { BridgeRequestFrame, JsonValue } from "./ipc-server/protocol.js";
import { PairingStore, type PairedClient, type PairingRequest, type PairingResult } from "./ipc-server/pairing.js";
import { signDescriptor, writeDescriptorFile } from "./ipc-server/descriptor.js";
import { createDeviceIdentity } from "./devices/identity.js";
import { CompositeAuditSink, FileAuditSink, MemoryAuditSink, RingAuditSink, type AuditEvent } from "./diagnostics/audit.js";
import { CrashRing } from "@ambient/shared/observability";
import { AMBIENT_BRIDGE_CAPABILITIES, AMBIENT_BRIDGE_IPC_PROTOCOL_VERSION } from "@ambient/shared/product-version";
import { excludeWindowFromSelfCapture } from "@ambient/shared/window-capture";
import { bridgeShellStatusSignature } from "./shell-status-signature.js";
import { BRIDGE_STATUS_REQUEST_LIMIT } from "./status-dto-limits.js";
import {
  createBridgeCrashReportStore,
  type BridgeCrashOrigin,
} from "./diagnostics/crash-report.js";
import { EncryptedSessionStore } from "./workos/token-store.js";
import { LocalSecretVault } from "./local-secret-vault.js";
import { buildBridgeTrayMenuTemplate } from "./tray-menu.js";
import { clearBridgeUserQuitMarker, writeBridgeUserQuitMarker } from "./user-quit-marker.js";
import {
  shouldRefreshWorkOsSession,
  workOsSessionExpiresAtSeconds,
  type WorkOsFeatureFlagsByOrganization,
  type SignedInWorkOsSession,
  type WorkOsOrganization,
  type WorkOsSession,
} from "./workos/session.js";
import { discardResponseBody, streamResponseBody } from "./proxy/streaming.js";
import { ownedInferenceStream } from "./inference/owned-stream.js";
import {
  AuthServerRequestError,
  AuthServerClient,
  BRIDGE_RETURN_URI,
  parseBridgeAuthCallback,
  type AuthBrokerSessionResponse,
  type AuthOrganizationFeatureFlags,
} from "./auth/server-client.js";
import {
  BridgeAuditService,
  BridgeSecureClient,
  BridgeSessionService,
  createBridgeAuditService,
  createBridgePlaintextClient,
  createBridgeSecureClient,
  createCloudNodeSecureClient,
  createBridgeSessionService,
  secureInferenceResponse,
  type BridgeSecureClientShape,
  type InferenceProxyPath,
} from "./inference/effect.js";
import { forwardHandoffFeedback } from "./analytics/handoff-feedback.js";
import { forwardSupportFeedback, SUPPORT_FEEDBACK_BRIDGE_METHOD } from "./analytics/support-feedback.js";
import { parseServerTarget } from "@ambient/shared/server-targets";
import { persistServerTarget, resolveActiveServerTarget } from "./server-target.js";
import {
  loadPlaintextInferenceWarningHidden,
  persistPlaintextInferenceWarningHidden,
} from "./plaintext-inference-warning-preference.js";
import {
  forwardMultiplayerEffectivePolicy,
  forwardMultiplayerEncryption,
  forwardMultiplayerHeartbeat,
  forwardMultiplayerMcp,
  forwardMultiplayerMcpStatus,
  forwardMultiplayerRawCaptureAvailability,
  forwardMultiplayerRawCaptureUpload,
  RAW_CAPTURE_MAX_UPLOAD_BYTES,
  forwardMultiplayerMemory,
  forwardMultiplayerPublish,
  forwardMultiplayerCollection,
  forwardMultiplayerReport,
  forwardMultiplayerTrajectories,
} from "./multiplayer/forward.js";
import { audioTranscriptionRequestFromPayload, audioUploadMetadataFromPayload } from "./inference/audio-transcription.js";
import { NetworkRequestHistory, readEhbpResponseEvidence, readEhbpUsageAfterBody, type NetworkRequestRecord } from "./inference/network-log.js";
import { WireTap } from "./inference/wire-tap.js";
import {
  BridgeWindowLifecycleController,
  bridgeLoginItemSettingsOptions,
  isExplicitBackgroundLaunch,
  macBridgeActivationPolicy,
  resolveBridgeLaunchDecision,
  shouldDisableHardwareAcceleration,
  shouldShowMacDock,
  shouldOpenMainWindowOnLaunch,
} from "./window-lifecycle.js";
import {
  BRIDGE_RELEASE_DEFAULT_CHANNEL,
  bridgeChangelogUrl,
  bridgeUpdateBaseUrlFromEnv,
  bridgeUpdateFeedUrl,
  bridgeUpdaterUnavailableReason,
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
import {
  bridgeUninstallAvailability,
  uninstallPackagedBridge,
  type BridgeUninstallResult,
} from "./self-uninstall.js";
import { authCallbackUrlFromArgv, shouldUseLoopbackAuthCallback } from "./auth-callback.js";
import { inferenceRequestKey, InferenceRequestRegistry } from "./inference/request-registry.js";
import {
  InferenceAvailabilityCircuit,
  inferenceAccessBlockReason,
  sessionUsageOwnerKey,
  type InferenceAccessBlockReason,
  type InferenceAvailabilitySnapshot,
} from "./inference/availability.js";
import { createBridgeUsageService } from "./inference/usage-service.js";
import { BridgeUsageCache } from "./inference/usage-cache.js";
import { BridgeModelAssignmentCache } from "./inference/model-assignment-cache.js";
import { BridgeInferencePlanCache, type BridgeInferencePlanSnapshot } from "./inference/plan-cache.js";
import { BridgePricingCache } from "./inference/pricing-cache.js";
import { BridgeGloballyDisabledError, BridgeInsufficientCreditError, globallyDisabledRefusalText, inferenceDomainError } from "./inference/errors.js";
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
  BUILD_APP_ID,
  BUILD_APP_NAME,
  BUILD_BAKE_MARKER,
  BUILD_COMMIT_SHA,
  BUILD_DEFAULT_MULTIPLAYER_URL,
  BUILD_DEFAULT_SERVER_URL,
  BUILD_RELEASE_CHANNEL,
} from "./generated/build-config.js";
import { resolveBridgeDesktopIdentity } from "./desktop-identity.js";
import {
  createCloudNodeRoutingService,
  cloudNodeSessionBoundaryKey,
  inferenceRouteFromAssignment,
  type CloudNodeRoute,
} from "./cloud/node-assignment.js";
import {
  assertInferencePathAllowedInMode,
  inferenceClientForMode,
  nodeModeForRequest,
  requestInferenceModeFromPayload,
  type RequestInferenceMode,
} from "./inference/request-mode.js";
import { BridgeOrgPolicyCache, globalControlsSignature, type BridgeOrgPolicyStatus } from "./cloud/org-policy-cache.js";
import { orgPolicyFeatureSlugs, withoutGloballyDisabledSlugs } from "@alexandria/cloud-contract";

const requireFromMain = createRequire(import.meta.url);
const { autoUpdater } = requireFromMain("electron-updater") as typeof import("electron-updater");
const desktopIdentity = resolveBridgeDesktopIdentity({
  buildAppId: BUILD_APP_ID,
  buildAppName: BUILD_APP_NAME,
  packaged: app.isPackaged,
  packagedAppName: app.getName(),
});
const APP_ID = desktopIdentity.appId;
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

const bridgeStatusClock = new BridgeStatusClock();

type BridgeStatus = {
  bridgeInstanceId: string;
  revision: number;
  account: BridgeAccountState;
  authError?: string;
  appVersion: string;
  connection: "ready" | "starting" | "checking" | "retrying" | "degraded" | "proxy_unavailable" | "attestation_invalid" | "offline";
  inference: BridgeInferenceStatus;
  plaintextInferenceWarningHidden: boolean;
  nodeRouting: {
    state: string;
    organizationId: string | null;
    workspaceId: string | null;
    workspaceKind: "personal" | "workos_org" | null;
    installationId: string | null;
    origin: string | null;
    capabilities: string[];
    entitlements: {
      inference: boolean;
      multiplayer: boolean;
      publishing: boolean;
      mcp: boolean;
    };
    inferenceMode: "confidential" | "plaintext" | null;
    configurationVersion: number | null;
    message: string | null;
  };
  /** Published Cloud org policy for the signed-in organization (ADR-0295). */
  orgPolicy: BridgeOrgPolicyStatus;
  pairedClientList: BridgePairedClient[];
  pairedClients: number;
  pairingRequests: BridgePairingRequest[];
  runtimeIdentity: {
    channel: string;
    commitSha: string;
    serverUrl: string;
    serverTarget: "staging" | "production" | null;
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

type BridgeRequestLogSnapshot = {
  revision: number;
  requests: BridgeInferenceRequestStatus[];
};

type BridgeRequestLogPatch = {
  revision: number;
  upserts: BridgeInferenceRequestStatus[];
  removeIds?: string[];
  reset?: boolean;
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
  availability: InferenceAvailabilitySnapshot;
  attestation: "not_checked" | "verifying" | "verified" | "failed";
  attestationChecks: BridgeAttestationCheck[];
  attestationInProgress: boolean;
  encryption: "ehbp" | "none";
  lastError: string | null;
  lastRequest: BridgeInferenceRequestStatus | null;
  responsePrivacy: "decrypts_in_bridge";
  serverAuth: "workos_session" | "cloud_node_identity";
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
  loginUrl: string;
  completing?: Promise<LoginCallbackOutcome>;
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
const USAGE_RECOVERY_INTERVAL_MS = 60_000;
const ORG_POLICY_POLL_INTERVAL_MS = 60_000;
// Proactive session-refresh retry budget. A stale access token gets renewed on
// launch (and when the server comes back online) before the first inference
// request; a transient WorkOS/network failure at boot is retried with backoff
// so auth self-heals instead of wedging until a manual sign-out and back in.
const SESSION_REFRESH_MAX_ATTEMPTS = 5;
const SESSION_REFRESH_BASE_DELAY_MS = 2_000;
const SESSION_REFRESH_MAX_DELAY_MS = 30_000;
const AMBIENT_SESSION_TOKEN_HEADER = "x-ambient-session-token";
const STALE_SESSION_MESSAGE = "Your Bridge sign-in expired. Sign in again to continue.";
const APP_NAME = desktopIdentity.appName;
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
// Bridge never uses Chromium GPU. Must run before app.ready; Open later
// software-composites. Ambient keeps GPU so the product UI stays smooth.
const bridgeLaunchDecision = resolveBridgeLaunchDecision({
  argv: process.argv,
  env: process.env,
  loginItemSettings: readBridgeLoginItemSettingsBestEffort(),
});
// Silent (managed headless) launches never create a window or tray icon.
const bridgeSilentMode = bridgeLaunchDecision.reason === "silent";
if (shouldDisableHardwareAcceleration()) {
  app.disableHardwareAcceleration();
}

// In unpackaged Electron the dock would otherwise show the stock icon if a
// tile briefly appears before accessory policy sticks. Packaged builds get
// their icon from the bundle's .icns and use LSUIElement so there is no tile.
function applyDevDockIcon(): void {
  if (process.platform !== "darwin" || app.isPackaged || !app.dock) return;
  // main.js runs from dist/electron/, so resources/ sits two levels up.
  const iconPath = join(import.meta.dirname, "..", "..", "resources", "bridge-icon-source.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) {
    app.dock.setIcon(icon);
  }
  // setIcon can resurface a hidden Dock tile; re-hide after branding.
  if (!shouldShowMacDock(process.platform, "background")) {
    app.dock.hide();
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
    // Monochrome canonical Bridge mark: the "Template" filename makes Electron
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
  if (image.isEmpty()) return image;
  if (process.platform === "linux") {
    // StatusNotifier hosts (GNOME AppIndicator, KDE, Waybar) disagree on how
    // aggressively to scale a large source image. Publish a panel-sized bitmap
    // so the Bridge does not collapse into an effectively invisible icon.
    return image.resize({ height: 22, width: 22 });
  }
  if (process.platform !== "darwin") return image;

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
const loginStartGate = new LoginStartGate();
const loginListener = new LoopbackLoginListener(query => handleAuthCallback(`${BRIDGE_RETURN_URI}${query}`));
let authError: string | undefined;
let workOsSessionStore: EncryptedSessionStore | undefined;
let organizationsRefresh: {
  readonly generation: number;
  readonly boundaryKey: string;
  readonly pending: Promise<void>;
} | null = null;
const statusEvents = new EventEmitter();
statusEvents.setMaxListeners(50);
let lastAuthStatusSnapshotSignature: string | null = null;
let lastShellStatusSignature: string | null = null;

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
if (!BUILD_BAKE_MARKER.startsWith("ambient-bake:")) {
  throw new Error(`Invalid BUILD_BAKE_MARKER ${BUILD_BAKE_MARKER}`);
}
const activeServer = resolveActiveServerTarget({
  bakedMultiplayerUrl: BUILD_DEFAULT_MULTIPLAYER_URL,
  bakedServerUrl: BUILD_DEFAULT_SERVER_URL,
  userDataDir: app.getPath("userData"),
});
const serverBaseUrl = activeServer.serverUrl;
const multiplayerBaseUrl = activeServer.multiplayerUrl;
const activeInferenceRequests = new InferenceRequestRegistry();
const activeAttestationChecks = new Set<string>();
let inferenceGeneration = 0;
const networkHistory = new NetworkRequestHistory();
let requestLogRevision = 0;
const wireTap = new WireTap({
  onEvict: () => {
    markWireCaptureChanged();
  },
  onUpdate: (requestId) => {
    const record = networkHistory.patchLatestByRequestId(requestId, { wireCaptured: true });
    markWireCaptureChanged();
    if (record) publishRequestLogUpserts([record]);
  },
});
wireTap.install();
const bridgeAuditService = createBridgeAuditService(audit);
// Confidential Node clients verify attestation and seal requests with EHBP.
const bridgeSecureClient = createBridgeSecureClient({ serverBaseUrl });
const nodeSecureClients = new Map<string, BridgeSecureClientShape>();
let plaintextInferenceWarningHidden = loadPlaintextInferenceWarningHidden(app.getPath("userData"));
let inferenceStatus: BridgeInferenceStatus = initialInferenceStatus();
const authServer = new AuthServerClient({ baseUrl: serverBaseUrl });
const cloudNodeRouting = createCloudNodeRoutingService({
  cloudBaseUrl: serverBaseUrl,
  legacyMultiplayerBaseUrl: multiplayerBaseUrl,
  onRotatedSessionToken: storeRotatedSessionTokenValue,
  onStateChange: () => notifyStatusChanged(),
  appVersion: app.getVersion(),
  platform: process.platform,
});
const bridgeUsageService = createBridgeUsageService(authServer);
const bridgeUsageCache = new BridgeUsageCache();
const bridgeModelAssignmentCache = new BridgeModelAssignmentCache();
// Per-account inference plan (ADR-0297); `inference.models` stays for released apps.
const bridgeInferencePlanCache = new BridgeInferencePlanCache({
  fetch: (sessionToken, etag) => authServer.inferencePlan(sessionToken, etag),
  onError: (error) => audit.record("inference.plan_refresh_failed", { message: safeStatusMessage(errorMessage(error)) }),
});
const bridgeOrgPolicyCache = new BridgeOrgPolicyCache({
  directory: join(app.getPath("userData"), "org-policy"),
  fetch: (sessionToken, etag) => authServer.orgPolicy(sessionToken, etag),
  onChange: () => notifyStatusChanged(),
});
const orgPolicyPollTimer = setInterval(() => {
  void refreshOrgPolicy("poll");
}, ORG_POLICY_POLL_INTERVAL_MS);
orgPolicyPollTimer.unref?.();
const bridgePricingCache = new BridgePricingCache();
const inferenceAvailability = new InferenceAvailabilityCircuit();
const usageRecoveryTimer = setInterval(() => {
  void refreshExhaustedAccountCircuit();
}, USAGE_RECOVERY_INTERVAL_MS);
usageRecoveryTimer.unref?.();
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
    if (process.platform === "darwin") {
      app.hide();
      applyMacBridgePresentation("background");
    }
  },
  destroyTray,
  onStateChange: (state) => {
    audit.record("lifecycle.state_changed", {
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
    closePendingLoginCallback();
    loginListener.close();
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
    // Compact Bridge shell. Ambient onboarding is wider (1120×640) for the
    // Privacy Apps|Sites split; Bridge keeps this size so settings stay dense.
    // The #544 720×480 shrink left the modal flush against the window padding.
    width: 960,
    height: 600,
    minHeight: 520,
    minWidth: 720,
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
  });

  excludeWindowFromSelfCapture(window);

  if (process.platform === "win32" && icon) {
    window.setAppDetails({
      appId: APP_ID,
      appIconPath: icon,
      appIconIndex: 0,
      relaunchDisplayName: APP_NAME,
    });
  }

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
  if (bridgeSilentMode) {
    audit.record("lifecycle.window_show_suppressed", { reason });
    return;
  }
  if (!app.isReady()) {
    pendingShowMainWindowReason = reason;
    return;
  }
  void showMainWindowNow(reason);
}

async function showMainWindowNow(reason: string): Promise<void> {
  if (bridgeSilentMode) {
    audit.record("lifecycle.window_show_suppressed", { reason });
    return;
  }
  try {
    await windowLifecycle.showMainWindow();
    audit.record("lifecycle.window_shown", { reason });
  } catch (error) {
    console.error("[bridge] failed to show main window", errorMessage(error));
    audit.record("lifecycle.window_show_failed", { message: safeStatusMessage(errorMessage(error)), reason });
  }
}

function applyMacBridgePresentation(state: "background" | "visible"): void {
  if (process.platform !== "darwin") return;
  try {
    app.setActivationPolicy(macBridgeActivationPolicy(state));
  } catch (error) {
    audit.record("lifecycle.activation_policy_failed", { message: safeStatusMessage(errorMessage(error)) });
  }
  if (!app.dock) return;
  if (shouldShowMacDock(process.platform, state)) void app.dock.show();
  else app.dock.hide();
}

function activateBridgeAppForUser(): void {
  if (process.platform !== "darwin") return;
  applyMacBridgePresentation("visible");
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
        { label: `Open ${APP_NAME}`, accelerator: "Command+O", click: () => showMainWindow() },
        { label: "Hide Window", accelerator: "Command+W", click: () => windowLifecycle.hideMainWindow() },
        { type: "separator" },
        { label: `Quit ${APP_NAME}`, accelerator: "Command+Q", click: () => windowLifecycle.requestQuit() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Create a quiet tray/menu-bar icon so Bridge remains reachable after its
// window is hidden. On macOS either mouse button opens the same Open/Quit menu;
// other desktop platforms retain click-to-open plus their native context menu.
function setupTray(): void {
  if (bridgeSilentMode) return;
  if (process.platform !== "win32" && process.platform !== "darwin" && process.platform !== "linux") return;
  if (tray && !tray.isDestroyed()) return;

  const image = createBridgeTrayImage();
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip(APP_NAME);
  updateTrayMenu();

  if (process.platform === "darwin") {
    const showTrayMenu = () => {
      if (tray && !tray.isDestroyed() && trayMenu) tray.popUpContextMenu(trayMenu);
    };
    tray.on("click", showTrayMenu);
    tray.on("right-click", showTrayMenu);
  } else {
    tray.on("click", () => showMainWindow());
    tray.on("double-click", () => showMainWindow());
  }
}

function updateTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return;
  trayMenu = Menu.buildFromTemplate(buildBridgeTrayMenuTemplate({
    appName: APP_NAME,
    handlers: {
      onQuit: () => windowLifecycle.requestQuit(),
      onShow: () => showMainWindow(),
    },
  }));
  if (process.platform !== "darwin") {
    tray.setContextMenu(trayMenu);
  }
}

function getBridgeLoginItemSettings(): Electron.LoginItemSettings {
  const options = bridgeLoginItemSettingsOptions({ execPath: process.execPath, platform: process.platform });
  return options ? app.getLoginItemSettings(options) : app.getLoginItemSettings();
}

function readBridgeLoginItemSettingsBestEffort(): Electron.LoginItemSettings | undefined {
  try {
    return getBridgeLoginItemSettings();
  } catch {
    return undefined;
  }
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

  const multiplayerHandlers = {
    "status": async () => multiplayerRoutingStatusPayload() as unknown as JsonValue,
    "effectivePolicy": async (frame) => (
      await forwardMultiplayerEffectivePolicy(frame.id, multiplayerForwardOptions())
    ) as unknown as JsonValue,
    "encryption": async (frame) => (
      await forwardMultiplayerEncryption(frame.id, multiplayerForwardOptions())
    ) as unknown as JsonValue,
    "collection": async (frame) => (await forwardMultiplayerCollection(frame.id, frame.payload, multiplayerForwardOptions())) as JsonValue,
    "publish": async (frame) => (
      await forwardMultiplayerPublish(frame.id, frame.payload, multiplayerForwardOptions())
    ) as unknown as JsonValue,
    "report": async (frame) => (
      await forwardMultiplayerReport(frame.id, frame.payload, multiplayerForwardOptions())
    ) as unknown as JsonValue,
    "heartbeat": async (frame) => (
      await forwardMultiplayerHeartbeat(frame.id, multiplayerForwardOptions())
    ) as unknown as JsonValue,
    "memory": async (frame) => (
      await forwardMultiplayerMemory(frame.id, frame.payload, multiplayerForwardOptions())
    ) as unknown as JsonValue,
    "trajectories": async (frame) => (
      await forwardMultiplayerTrajectories(frame.id, frame.payload, multiplayerForwardOptions())
    ) as unknown as JsonValue,
    "mcp": async (frame) => (
      await forwardMultiplayerMcp(frame.id, frame.payload, multiplayerForwardOptions())
    ) as unknown as JsonValue,
    "mcpStatus": async (frame) => (
      await forwardMultiplayerMcpStatus(frame.id, multiplayerForwardOptions())
    ) as unknown as JsonValue,
  } satisfies Record<string, IpcMethodHandler>;
  // Raw capture is a new generation-only surface: no legacy lighthouse alias.
  const rawCaptureMethods: Record<string, IpcMethodHandler> = {
    "multiplayer.rawCaptureAvailability": async (frame) => (
      await forwardMultiplayerRawCaptureAvailability(frame.id, multiplayerForwardOptions())
    ) as unknown as JsonValue,
    "multiplayer.rawCaptureUpload": async (frame, context) => {
      const manifest = frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
        ? (frame.payload as { manifest?: { byteLength?: unknown; sha256?: unknown } }).manifest : undefined;
      const expectedByteLength = typeof manifest?.byteLength === "number" ? manifest.byteLength : undefined;
      if (!expectedByteLength || expectedByteLength > RAW_CAPTURE_MAX_UPLOAD_BYTES) throw new Error("Invalid raw capture upload.");
      const bytes = await context.readBinaryUpload({ expectedByteLength, maxBytes: RAW_CAPTURE_MAX_UPLOAD_BYTES,
        ...(typeof manifest?.sha256 === "string" ? { expectedSha256: manifest.sha256 } : {}) });
      return (await forwardMultiplayerRawCaptureUpload(frame.id, frame.payload, bytes, multiplayerForwardOptions())) as unknown as JsonValue;
    },
  };
  // Both protocol generations share each handler, including its live options.
  const multiplayerMethods: Record<string, IpcMethodHandler> = {};
  for (const prefix of ["multiplayer", "lighthouse"]) {
    for (const [name, handler] of Object.entries(multiplayerHandlers)) {
      multiplayerMethods[`${prefix}.${name}`] = handler;
    }
  }

  const server = new BridgeIpcServer({
    audit,
    handlers: {
      "bridge.health": async () => ({
        // The app sends a feature's new request fields only to a Bridge listing it.
        capabilities: [AMBIENT_BRIDGE_CAPABILITIES.inferenceMode],
        ok: true,
        protocolVersion: AMBIENT_BRIDGE_IPC_PROTOCOL_VERSION,
        version: app.getVersion(),
      }),
      "bridge.status": async (frame) => getStatus({
        forceRefreshReachability: payloadBoolean(frame.payload, "refreshReachability"),
        forceRefreshSession: payloadBoolean(frame.payload, "refreshSession"),
      }),
      "bridge.setServerTarget": async (frame) => setHostedServerTarget(payloadString(frame.payload, "target")),
      "bridge.setPlaintextInferenceWarningHidden": async (frame) => (
        setPlaintextInferenceWarningHidden(payloadBoolean(frame.payload, "hidden"))
      ),
      "bridge.statusSubscribe": (_frame, context) => statusSubscriptionStream(context.socketClosed),
      "bridge.refreshStatus": async (frame) => {
        await getStatus({
          forceRefreshSession: payloadBoolean(frame.payload, "refreshSession"),
          forceRefreshReachability: payloadBoolean(frame.payload, "refreshReachability"),
        });
        statusEvents.emit("changed");
        return { ok: true };
      },
      "auth.integrationToken": async () => integrationTokenPayload(),
      "auth.session": async () => localSessionPayload(),
      "auth.cancelSignIn": async () => cancelSignInViaIpc(),
      "auth.signIn": async (frame) => signInViaIpc({ restart: payloadBoolean(frame.payload, "restart"), reopen: payloadBoolean(frame.payload, "reopen") }),
      "auth.signOut": async () => {
        await performSignOut();
        return { ok: true };
      },
      "auth.switchOrganization": async (frame) => {
        const organizationId = payloadString(frame.payload, "organizationId");
        if (!organizationId) {
          throw new Error("organizationId is required.");
        }
        return switchOrganization(organizationId, { showBridgeOnCompletion: false });
      },
      "auth.organizations": async () => organizationsPayload(),
      "usage.summary": async (frame) => (
        await usageSnapshotPayload(payloadBoolean(frame.payload, "refresh"))
      ) as unknown as JsonValue,
      "usage.pricing": async (frame) => (
        await usagePricingPayload(payloadBoolean(frame.payload, "refresh"))
      ) as unknown as JsonValue,
      "usage.breakdown": async () => (
        await usageModelBreakdownPayload()
      ) as unknown as JsonValue,
      "usage.instanceHistory": async () => (
        await usageInstanceHistoryPayload()
      ) as unknown as JsonValue,
      "usage.topupOptions": async (frame) => (
        await usageTopupOptionsPayload(payloadBoolean(frame.payload, "customAmounts"))
      ) as unknown as JsonValue,
      "usage.createTopupCheckout": async (frame) => (
        await usageCreateTopupCheckoutPayload(frame.payload)
      ) as unknown as JsonValue,
      "usage.billing": async () => (
        await usageBillingPayload((token) => authServer.usageBillingState(token))
      ) as unknown as JsonValue,
      "usage.billingSetupIntent": async () => (
        await usageBillingPayload((token) => authServer.createUsageBillingSetupIntent(token), { mutates: false })
      ) as unknown as JsonValue,
      "usage.billingAttachPaymentMethod": async (frame) => {
        const setupIntentId = payloadString(frame.payload, "setupIntentId");
        if (!setupIntentId || !/^seti_[A-Za-z0-9_]{1,200}$/.test(setupIntentId)) {
          throw new Error("A completed card setup is required.");
        }
        return (await usageBillingPayload(
          (token) => authServer.attachUsageBillingPaymentMethod(token, setupIntentId),
          { mutates: true },
        )) as unknown as JsonValue;
      },
      "usage.billingRemovePaymentMethod": async () => (
        await usageBillingPayload((token) => authServer.removeUsageBillingPaymentMethod(token), { mutates: true })
      ) as unknown as JsonValue,
      "usage.billingSetSpendingLimit": async (frame) => (
        await usageBillingPayload(
          (token) => authServer.setUsageSpendingLimit(token, spendingLimitPayload(frame.payload)),
          { mutates: true },
        )
      ) as unknown as JsonValue,
      "usage.billingSetMode": async (frame) => {
        const mode = payloadString(frame.payload, "mode");
        if (mode !== "usage" && mode !== "credits") throw new Error("Billing mode must be usage or credits.");
        return (await usageBillingPayload((token) => authServer.setUsageBillingMode(token, mode), { mutates: true })) as unknown as JsonValue;
      },
      "plans.list": async () => (await plansListPayload()) as unknown as JsonValue,
      "plans.checkout": async (frame) => (await planCheckoutPayload(payloadString(frame.payload, "planId"))) as unknown as JsonValue,
      "plans.portal": async () => (await planPortalPayload()) as unknown as JsonValue,
      "inference.models": async (frame) => (
        await inferenceModelsSnapshotPayload(payloadBoolean(frame.payload, "refresh"))
      ) as unknown as JsonValue,
      "inference.plan": async (frame) => (
        await inferencePlanSnapshotPayload(payloadBoolean(frame.payload, "refresh"))
      ) as unknown as JsonValue,
      "announcements.list": async (frame) => (
        await announcementsSnapshotPayload(payloadBoolean(frame.payload, "refresh"))
      ) as unknown as JsonValue,
      "analytics.handoffFeedback": async (frame) => forwardHandoffFeedbackAnalytics(frame),
      [SUPPORT_FEEDBACK_BRIDGE_METHOD]: async (frame) => forwardSupportFeedbackToCloud(frame),
      ...multiplayerMethods,
      ...rawCaptureMethods,
      "inference.audioSpeech": async () => unsupportedInferenceMethod("inference.audioSpeech"),
      "inference.audioTranscriptions": (frame, context) => forwardAudioTranscription(frame, context),
      "inference.chatCompletions": (frame, context) => forwardInference(frame, context, "/v1/chat/completions"),
      "inference.embeddings": (frame, context) => forwardInference(frame, context, "/v1/embeddings"),
      "inference.responses": (frame, context) => forwardInference(frame, context, "/v1/responses"),
      "inference.dailyReport": (frame, context) => forwardInference(frame, context, "/v1/responses"),
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
  await writeFile(join(supportDir, "diagnostic-support.json"), JSON.stringify({
    schemaVersion: 1, version: app.getVersion(),
    logPath: join(app.getPath("userData"), "logs", "bridge-audit.jsonl"),
  }), { mode: 0o600 }).catch((error: unknown) => {
    audit.record("diagnostics.support_marker_failed", { message: safeStatusMessage(errorMessage(error)) });
  });
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
  let [session, reachability, socketReady] = await Promise.all([
    sessionStore().read(),
    currentServerReachability({ force: options.forceRefreshReachability === true }),
    ensureIpcSocketAlive(),
  ]);
  const currentNodeRouting = await Effect.runPromise(cloudNodeRouting.snapshot());
  if (
    session.kind === "signed_in"
    && !bridgeUiE2eWireUrl()
    && (
      currentNodeRouting.state === "unknown"
      || (options.forceRefreshReachability === true
        && (currentNodeRouting.state === "unavailable" || currentNodeRouting.state === "seat_limit_reached"))
    )
  ) {
    // Status must stay local-fast: bootstrap runs in the background and its
    // state-change callback wakes statusSubscribe with resolving/ready/error.
    // Do not restart a failed bootstrap from the status-change notification;
    // that would create an unbounded retry loop while Cloud is unavailable.
    void Effect.runPromise(cloudNodeRouting.resolve(session, {
      force: options.forceRefreshReachability === true,
    })).catch(() => undefined);
  }
  if (session.kind === "signed_in" && !bridgeUiE2eWireUrl()) {
    // Local-fast like node routing: the fetch runs in the background and the
    // cache's change callback wakes statusSubscribe.
    void refreshOrgPolicy("status");
  }
  const nodeRoutingSnapshot = await Effect.runPromise(cloudNodeRouting.snapshot());
  if (session.kind === "signed_in" && nodeRoutingSnapshot.state === "ready") {
    // A seat was freed (bootstrap accepted this member again).
    inferenceAvailability.accessRestored(sessionUsageOwnerKey(session), "seat_limit_reached");
  }
  const nodeRouting: BridgeStatus["nodeRouting"] = {
    ...nodeRoutingSnapshot,
    capabilities: [...nodeRoutingSnapshot.capabilities],
  };
  const e2eFixture = bridgeUiE2eWireUrl() !== null;
  const serverReachable = e2eFixture || reachability.state === "reachable";
  const sessionRefresh = sessionRefreshCoordinator.snapshot();

  // No awaits between reading the current account and stamping its revision.
  // A status request started before logout must not label its old account with
  // the revision of the newly cleared session.
  session = sessionStore().peekCached() ?? session;
  const account = pendingLogin
    ? { kind: "login_pending" as const }
    : publicAccountState(bridgeUiE2eWireUrl() ? bridgeUiE2eSession() : session);
  const status: Omit<BridgeStatus, "bridgeInstanceId" | "revision"> = {
    account,
    appVersion: app.getVersion(),
    authError,
    connection: e2eFixture
      ? "ready"
      : connectionState({ reachability: reachability.state, sessionRefresh, socketReady }),
    inference: {
      ...inferenceStatus,
      activeRequests: activeInferenceRequests.size,
      availability: session.kind === "signed_in"
        ? inferenceAvailability.snapshot(sessionUsageOwnerKey(session))
        : inferenceAvailability.snapshot(),
      attestationChecks: inferenceStatus.attestationChecks.map((check) => ({ ...check })),
      attestationInProgress: activeAttestationChecks.size > 0,
      lastRequest: networkHistory.latest(),
    },
    plaintextInferenceWarningHidden,
    nodeRouting,
    orgPolicy: bridgeOrgPolicyCache.snapshot(
      account.kind === "signed_in" ? account.featureFlags.evaluatedFor.organizationId : null,
    ),
    pairedClientList: pairingStore.listClients().map(publicPairedClient),
    pairedClients: pairingStore.listClients().filter((client) => !client.credential.revokedAt).length,
    pairingRequests: pairingStore.listRequests()
      .filter((request) => request.status === "pending")
      .map(publicPairingRequest),
    runtimeIdentity: {
      channel: BUILD_RELEASE_CHANNEL,
      commitSha: BUILD_COMMIT_SHA,
      serverUrl: new URL(serverBaseUrl).origin,
      serverTarget: activeServer.target,
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
  return { ...status, ...bridgeStatusClock.observe(JSON.stringify(status)) };
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

function getRequestLog(): BridgeRequestLogSnapshot {
  return {
    revision: requestLogRevision,
    requests: networkHistory.list(BRIDGE_STATUS_REQUEST_LIMIT),
  };
}

function publishRequestLogUpserts(records: readonly BridgeInferenceRequestStatus[]): void {
  if (records.length === 0) return;
  requestLogRevision += 1;
  sendToMainWindow("bridge:request-log-changed", {
    revision: requestLogRevision,
    upserts: records.map((record) => ({ ...record })),
  } satisfies BridgeRequestLogPatch);
}

function publishRequestLogReset(): void {
  requestLogRevision += 1;
  sendToMainWindow("bridge:request-log-changed", {
    revision: requestLogRevision,
    reset: true,
    upserts: [],
  } satisfies BridgeRequestLogPatch);
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
ipcMain.handle("bridge:get-request-log", () => getRequestLog());
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

ipcMain.handle("bridge:get-uninstall-availability", () => bridgeUninstallAvailability({
  execPath: process.execPath,
  packaged: app.isPackaged,
  platform: process.platform,
}));

ipcMain.handle("bridge:uninstall", async () => {
  const options = { execPath: process.execPath, packaged: app.isPackaged, platform: process.platform };
  const availability = bridgeUninstallAvailability(options);
  if (!availability.available) throw new Error(availability.reason ?? "Ambient Bridge cannot be uninstalled here.");

  audit.record("lifecycle.uninstall_requested", {});
  writeBridgeUserQuitMarker(bridgeIpcSupportDir());
  try {
    await uninstallPackagedBridge({
      ...options,
      productName: app.getName(),
      trashItem: (target) => shell.trashItem(target),
    });
  } catch (error) {
    clearBridgeUserQuitMarker(bridgeIpcSupportDir());
    audit.record("lifecycle.uninstall_failed", { message: safeStatusMessage(errorMessage(error)) });
    throw error;
  }
  audit.record("lifecycle.uninstall_completed", {});
  setImmediate(() => windowLifecycle.requestQuit());
  return { status: "uninstalled" } satisfies BridgeUninstallResult;
});

async function startLoginFlow(options: {
  organizationId?: string;
  showBridgeOnCompletion?: boolean;
  restart?: boolean;
  reopen?: boolean;
} = {}): Promise<void> {
  if (options.restart || (pendingLogin && options.organizationId !== pendingLogin.organizationId)) closePendingLoginCallback();
  return loginStartGate.run(async isCurrent => {
    if (pendingLogin) {
      pendingLogin.showBridgeOnCompletion ||= options.showBridgeOnCompletion === true;
      if (options.reopen && !pendingLogin.completing) await shell.openExternal(pendingLogin.loginUrl);
      notifyStatusChanged();
      return;
    }
    authError = undefined;
    const clientState = randomBytes(32).toString("base64url");
    const returnUri = useLoopbackAuthCallback() ? await loginListener.open() : BRIDGE_RETURN_URI;
    if (!isCurrent()) return;
    const callbackTimeout = setTimeout(() => handleLoginTimeout(clientState), LOGIN_CALLBACK_TIMEOUT_MS);
    callbackTimeout.unref();
    const login: PendingLogin = {
      callbackReturnUri: returnUri, callbackTimeout, clientState,
      loginUrl: authServer.createLoginUrl(clientState, returnUri, options.organizationId),
      organizationId: options.organizationId,
      showBridgeOnCompletion: options.showBridgeOnCompletion === true,
    };
    pendingLogin = login;
    audit.record("auth.login_start", {});
    notifyStatusChanged();
    try { await shell.openExternal(login.loginUrl); }
    catch (error) {
      if (pendingLogin === login) {
        closePendingLoginCallback(); authError = errorMessage(error); notifyStatusChanged();
      }
      throw error;
    }
  }, options.organizationId ?? "");
}

function setPlaintextInferenceWarningHidden(hidden: boolean): JsonValue {
  if (plaintextInferenceWarningHidden === hidden) {
    return { hidden, ok: true };
  }
  persistPlaintextInferenceWarningHidden(app.getPath("userData"), hidden);
  plaintextInferenceWarningHidden = hidden;
  audit.record("inference.plaintext_warning_visibility_changed", { hidden });
  notifyStatusChanged();
  return { hidden, ok: true };
}

async function setHostedServerTarget(rawTarget: string | null): Promise<JsonValue> {
  const target = parseServerTarget(rawTarget);
  if (!target) {
    throw new Error("target must be staging or production.");
  }
  persistServerTarget(app.getPath("userData"), target);
  audit.record("server.target_changed", { target });
  try {
    await performSignOut();
  } catch (error) {
    audit.record("server.target_sign_out_failed", { message: errorMessage(error) });
  }
  setImmediate(() => {
    app.relaunch();
    app.exit(0);
  });
  return { ok: true, relaunching: true, target };
}

async function performSignOut(): Promise<void> {
  closePendingLoginCallback();
  const store = sessionStore();
  const session = await store.read();
  const sessionToken = session.kind === "signed_in" ? session.sessionToken : null;
  authError = undefined;
  await store.clear();
  clearInferenceTransparency();
  audit.record("auth.sign_out", {});
  notifyStatusChanged();

  // Local sign-out is authoritative and immediate. WorkOS logout plus browser
  // presentation is best-effort and must never leave Bridge appearing signed
  // in when the provider or browser is slow.
  if (sessionToken) {
    void (async () => {
      try {
        const logoutUrl = await authServer.createLogoutUrl(sessionToken);
        await shell.openExternal(logoutUrl);
      } catch (error) {
        audit.record("auth.logout_remote_failed", { message: errorMessage(error) });
      }
    })();
  }
}

function cancelPendingLogin(reason: string): boolean {
  loginStartGate.cancel();
  const login = pendingLogin;
  if (!login) { loginListener.retainForOldTabs(); return false; }
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

ipcMain.handle("bridge:start-login", (_event, options?: { restart?: boolean; reopen?: boolean }) => startLoginFlow({ restart: options?.restart === true, reopen: options?.reopen === true, showBridgeOnCompletion: true }));

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
  const authCallbackUrl = authCallbackUrlFromArgv(argv);
  if (authCallbackUrl) {
    void handleAuthCallback(authCallbackUrl);
    return;
  }
  // Finder / Start-menu reopen should reveal UI even though cold start stays
  // hidden. Only keep the surviving instance headless when the second launch
  // itself asked for background (login-item / --ambient-bridge-background).
  if (!isExplicitBackgroundLaunch(decision)) {
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
  applyMacBridgePresentation("background");
  // Dev dock icon must run after accessory/hide so setIcon cannot flash a tile.
  applyDevDockIcon();
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
  // Feed config only — do not checkForUpdates here. Ambient App reconciles
  // Bridge versions; this process stays silent unless Dev IPC asks.
  // Renew a stale WorkOS session on launch (with retry) so the first inference
  // request doesn't fail with "Auth provider unavailable" when the stored
  // access token expired while the app was closed. Refill the organization
  // directory afterwards, using the freshened token, so org switching works
  // without waiting for the first sign-in or token refresh.
  void refreshStoredSessionResilient("startup").finally(() => {
    void refreshOrganizations();
  });
  const launchDecision = bridgeLaunchDecision;
  audit.record("lifecycle.launch", {
    mode: launchDecision.mode,
    reason: launchDecision.reason,
    hardwareAcceleration: shouldDisableHardwareAcceleration() ? "off" : "on",
  });
  const pendingShowReason = pendingShowMainWindowReason;
  pendingShowMainWindowReason = null;
  if (pendingShowReason) {
    await showMainWindowNow(pendingShowReason);
  } else if (shouldOpenMainWindowOnLaunch(launchDecision)) {
    await showMainWindowNow("initial_launch");
  }
  armDevCrashTrigger();
}).catch((error) => {
  console.error("[bridge] startup failed", error);
  app.exit(1);
});

/**
 * Testing hook for local crash snapshots: with AMBIENT_DEV_CRASH_AFTER_MS set,
 * the Bridge main process throws an uncaught exception after that many ms.
 * Inert unless the env var is explicitly set to a valid delay.
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

async function handleAuthCallback(rawUrl: string): Promise<LoginCallbackOutcome> {
  const login = pendingLogin;
  // Validate before touching active state: stale tabs must never cancel it.
  try { parseBridgeAuthCallback(rawUrl, login?.clientState); } catch { return "replaced"; }
  if (!login) return "replaced";
  if (login.completing) return login.completing;
  if (login.callbackTimeout) clearTimeout(login.callbackTimeout);
  login.completing = completeLogin(rawUrl, login);
  return login.completing;
}

async function completeLogin(rawUrl: string, login: PendingLogin): Promise<LoginCallbackOutcome> {
  const store = sessionStore();
  let outcome: LoginCallbackOutcome = "failed";
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
    if (pendingLogin !== login) return "replaced";
    console.info("[bridge:auth] ticket redeemed", { userId: authSession.user.id });
    audit.record("auth.ticket_redeemed", { userId: authSession.user.id });

    clearInferenceTransparency();
    const written = await store.writeIfOwned(toStoredSession(authSession), () => pendingLogin === login);
    if (!written || pendingLogin !== login) return "replaced";
    // A request could have started with the old cached session while the new
    // encrypted session was being written. Advance the boundary again only
    // after replacement is durable so that work cannot survive re-auth.
    clearInferenceTransparency();
    console.info("[bridge:auth] session stored");
    audit.record("auth.session_stored", {});
    pendingLogin = undefined;
    outcome = "success";
    authError = undefined;
    audit.record("auth.login_complete", {
      userId: authSession.user.id,
    });
    void refreshOrganizations();
  } catch (error) {
    if (pendingLogin !== login) return "replaced";
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
  if (login.showBridgeOnCompletion) showMainWindow();
  return outcome;
}

function useLoopbackAuthCallback(): boolean {
  return shouldUseLoopbackAuthCallback({
    env: process.env,
    isPackaged: app.isPackaged,
    platform: process.platform,
  });
}

function closePendingLoginCallback(): void {
  loginStartGate.cancel();
  loginListener.retainForOldTabs();
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

function clearLoginResources(login: PendingLogin | undefined): void {
  if (!login) return;
  if (login.callbackTimeout) {
    clearTimeout(login.callbackTimeout);
  }
  if (!pendingLogin || pendingLogin === login) loginListener.retainForOldTabs();
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
    availability: { state: "ready" },
    attestation: "not_checked",
    attestationChecks: [],
    attestationInProgress: false,
    encryption: "ehbp",
    lastError: null,
    lastRequest: null,
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
  const record = networkHistory.start({
    attestation: "pending",
    encryption: "ehbp",
    feature: frame.method,
    model,
    path,
    requestBytes,
    requestId: frame.id,
    startedAt: Date.now(),
    traceId: frame.traceparent?.split("-")[1] ?? null,
  }, statusKey);
  publishRequestLogUpserts([record]);
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
  const record = networkHistory.patch(statusKey, { attestation: "pending" });
  if (record) publishRequestLogUpserts([record]);
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
  const record = networkHistory.patch(statusKey, { attestation: "verified" });
  if (record) publishRequestLogUpserts([record]);
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
  const record = networkHistory.patch(statusKey, { attestation: "failed" });
  if (record) publishRequestLogUpserts([record]);
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
  client: BridgeSecureClientShape = bridgeSecureClient,
  ownsRequest: () => boolean = () => generation === inferenceGeneration,
): BridgeSecureClientShape {
  return {
    fetch: client.fetch,
    ready: () =>
      Effect.sync(() => { if (ownsRequest()) beginInferenceAttestationCheck(statusKey, generation); }).pipe(
        Effect.flatMap(() => client.ready()),
        Effect.tap(() => Effect.sync(() => { if (ownsRequest()) completeInferenceAttestationCheck(statusKey, requestId, generation); })),
        Effect.tapError((error) => Effect.sync(() => { if (ownsRequest()) failInferenceAttestationCheck(
          statusKey,
          requestId,
          errorMessage(error),
          generation,
        ); })),
      ),
  };
}

function updateInferenceRequest(
  requestId: string,
  patch: Partial<BridgeInferenceRequestStatus>,
  options: { readonly publishLog?: boolean } = {},
): void {
  const record = networkHistory.patch(requestId, patch);
  if (options.publishLog === false || !record) return;
  publishRequestLogUpserts([record]);
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
  notifyStatusChanged();
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
  // Authentication and the request's mode (ADR-0313) are checked before admission;
  // `inferenceMode` is removed so the upstream body is the app's request only.
  authenticatedCredentialId(context);
  const { mode, payload } = requestInferenceModeFromPayload(frame.payload);
  const request = { ...frame, payload };
  return admitInferenceStream(request, context, path, jsonPayloadByteLength(request.payload), undefined, mode);
}

function forwardAudioTranscription(frame: BridgeRequestFrame, context: IpcHandlerContext): IpcStream {
  // Authentication and metadata validation must precede request admission.
  authenticatedCredentialId(context);
  const { mode, payload } = requestInferenceModeFromPayload(frame.payload);
  const request = { ...frame, payload };
  const metadata = audioUploadMetadataFromPayload(request.payload);
  return admitInferenceStream(request, context, "/v1/audio/transcriptions", metadata.expectedByteLength,
    (signal) => prepareAudioTranscriptionRequest(request, context, metadata, signal), mode);
}

const inferenceAdmissions = new Map<string, { retired: boolean }>();

function admitInferenceStream(
  frame: BridgeRequestFrame,
  context: IpcHandlerContext,
  path: InferenceProxyPath,
  requestBytes: number,
  prepare?: (signal: AbortSignal) => Promise<SecureInferenceRequestOverrides>,
  requestedMode: RequestInferenceMode | null = null,
): IpcStream {
  const credentialId = authenticatedCredentialId(context);
  const statusKey = inferenceRequestKey(credentialId, frame.id);
  const abortController = new AbortController();
  const generation = inferenceGeneration;
  activeInferenceRequests.register({ controller: abortController, credentialId, requestId: frame.id, socketClosed: context.socketClosed });
  const previous = inferenceAdmissions.get(statusKey);
  if (previous) previous.retired = true;
  const owner = { retired: false };
  inferenceAdmissions.set(statusKey, owner);
  activeAttestationChecks.delete(statusKey);
  inferenceStatus = { ...inferenceStatus, attestationInProgress: activeAttestationChecks.size > 0 };
  startInferenceStatus(frame, path, requestBytes, statusKey);
  const ownsRequest = () => !owner.retired && generation === inferenceGeneration;
  const request = prepare?.(abortController.signal);
  // Uploads start before the socket's first write; observe rejection even when
  // that write fails and the response iterator is never pulled.
  void request?.catch(() => {});
  return ownedInferenceStream(
    inferenceResponseStream(frame, path, statusKey, abortController, ownsRequest, request, generation, requestedMode),
    abortController,
    (cancel) => {
      const current = ownsRequest();
      owner.retired = true;
      if (inferenceAdmissions.get(statusKey) === owner) inferenceAdmissions.delete(statusKey);
      activeInferenceRequests.release(credentialId, frame.id, abortController);
      if (cancel) {
        if (current) {
          activeAttestationChecks.delete(statusKey);
          inferenceStatus = { ...inferenceStatus, attestationInProgress: activeAttestationChecks.size > 0 };
          completeInferenceStatus(statusKey, "cancelled", generation);
        }
      }
    },
  );
}

function jsonPayloadByteLength(payload: JsonValue | undefined): number {
  return Buffer.byteLength(JSON.stringify(payload ?? {}));
}

async function prepareAudioTranscriptionRequest(
  frame: BridgeRequestFrame,
  context: IpcHandlerContext,
  metadata: ReturnType<typeof audioUploadMetadataFromPayload>,
  signal: AbortSignal,
): Promise<SecureInferenceRequestOverrides> {
  const audio = await context.readBinaryUpload({
    signal,
    expectedByteLength: metadata.expectedByteLength,
    expectedSha256: metadata.expectedSha256,
    maxBytes: metadata.expectedByteLength,
  });
  return audioTranscriptionRequestFromPayload(frame.payload, audio);
}

async function* inferenceResponseStream(
  frame: BridgeRequestFrame,
  path: InferenceProxyPath,
  statusKey: string,
  abortController: AbortController,
  ownsRequest: () => boolean,
  request?: SecureInferenceRequestOverrides | Promise<SecureInferenceRequestOverrides>,
  generation = inferenceGeneration,
  requestedMode: RequestInferenceMode | null = null,
): IpcStream {
  audit.record("inference.forward_start", {
    method: frame.method,
    path,
    requestedMode: requestedMode ?? "assigned",
    requestId: frame.id,
  });

  let nodeRoute: CloudNodeRoute | null = null;
  let response: Response | undefined;
  try {
    const preparedRequest = await request;
    if (!ownsRequest()) return;
    nodeRoute = await resolveInferenceNodeRoute();
    if (!ownsRequest()) return;
    // The request's mode picks the transport (ADR-0313): the app's choice when it
    // sent one, else the Node's assigned mode. A Node serves every allowed mode, so
    // Confidential runs through the Tinfoil client even on a plaintext-default
    // Node. A Confidential request is never retried or rerouted as plaintext.
    const nodeMode = nodeModeForRequest(nodeRoute.inferenceMode, requestedMode);
    assertInferencePathAllowedInMode(path, nodeMode);
    const nodePlaintext = nodeMode === "plaintext";
    const routedSecureClient = createCloudNodeSecureClient({
      client: nodePlaintext
        ? createBridgePlaintextClient({ serverBaseUrl: nodeRoute.baseUrl })
        : nodeSecureClient(nodeRoute.baseUrl),
      accessToken: nodeRoute.accessToken,
      mode: nodeMode,
      feature: frame.method === "inference.dailyReport" ? "daily_report" : "bridge",
    });
    inferenceStatus = {
      ...inferenceStatus,
      attestation: nodePlaintext ? "not_checked" : inferenceStatus.attestation,
      encryption: nodePlaintext ? "none" : "ehbp",
      serverAuth: "cloud_node_identity",
      serverOrigin: publicOrigin(nodeRoute.baseUrl),
    };
    if (nodePlaintext) {
      updateInferenceRequest(statusKey, { attestation: "skipped", encryption: "none" });
    }
    const routedClientWithAttestation = secureClientWithAttestationStatus(
      statusKey,
      frame.id,
      generation,
      routedSecureClient,
      ownsRequest,
    );
    const selectedInferenceClient = inferenceClientForMode(
      nodeMode,
      {
        cloudNodePlaintext: routedSecureClient,
        cloudNodeConfidential: routedClientWithAttestation,
      },
    );
    const inferenceResult = await Effect.runPromise(
      secureInferenceResponse({
        appVersion: app.getVersion(),
        availability: inferenceAvailability,
        feature: frame.method,
        path,
        payload: frame.payload,
        ...preparedRequest,
        requestId: frame.id,
        signal: abortController.signal,
        traceparent: frame.traceparent,
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
          selectedInferenceClient,
        ),
        Effect.provideService(BridgeAuditService, bridgeAuditService),
        Effect.either,
      ),
    );
    if (inferenceResult._tag === "Left") throw inferenceResult.left;
    response = inferenceResult.right;
    if (!ownsRequest()) return;
    updateInferenceRequest(statusKey, {
      responseHeadersAt: Date.now(),
      statusCode: response.status,
      ...readEhbpResponseEvidence(response.headers),
    });
    if (!ownsRequest()) return;

    if (!response.ok) {
      throw await inferenceHttpError(response);
    }

    yield {
      contentType: response.headers.get("content-type"),
      kind: "openai.response.start",
      status: response.status,
    };

    let firstChunkObserved = false;
    for await (const chunk of streamResponseBody(response, abortController.signal)) {
      if (!ownsRequest()) return;
      if (chunk.kind === "delta") {
        if (!firstChunkObserved) {
          firstChunkObserved = true;
          updateInferenceRequest(statusKey, { firstChunkAt: Date.now() }, { publishLog: false });
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
    const lateUsage = await readEhbpUsageAfterBody(response);
    if (!ownsRequest()) return;
    if (lateUsage) {
      updateInferenceRequest(statusKey, { usage: lateUsage }, { publishLog: false });
    }
    completeInferenceStatus(statusKey, "completed", generation);
    void refreshInferenceUsageCircuit();
  } catch (error) {
    if (!ownsRequest()) return;
    if (generation === inferenceGeneration && nodeRoute && !isProviderInferenceError(error)) {
      // A failed customer-Node request can invalidate only the short-lived
      // destination credential. The WorkOS session remains Cloud-owned.
      await Effect.runPromise(cloudNodeRouting.invalidate()).catch(() => undefined);
    }
    if (!ownsRequest()) return;
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
    const domainError = inferenceDomainError(error);
    if (domainError instanceof BridgeInsufficientCreditError && domainError.summary) {
      bridgeUsageCache.observe(domainError.summary);
    } else if (error instanceof ProviderInferenceError && accessBlockReason(error)) {
      // Seat / member caps (ADR-0295 commercial terms) and plan refusals (ADR-0324): a precise card, not "out of credit".
      const cached = sessionStore().peekCached?.();
      if (cached?.kind === "signed_in") inferenceAvailability.accessBlocked(sessionUsageOwnerKey(cached), accessBlockReason(error)!);
    } else if (error instanceof ProviderInferenceError && error.code === "credit_exhausted") {
      // Cloud refused the grant (no credit, spending limit or failed invoice;
      // ADR-0243). The fresh summary carries the reason and trips the circuit.
      void refreshInferenceUsageCircuit().catch(() => undefined);
    }
    // A globally disabled provider/model (ADR-0296) is a per-request refusal:
    // no circuit, no access block. The thrown error keeps the prefixed text
    // for the app; Bridge's own request log shows the readable part.
    const globallyDisabled = globallyDisabledRefusalText(error);
    const safeMessage = safeStatusMessage(globallyDisabled ?? message);
    if (domainError && ownsRequest()) updateInferenceRequest(statusKey, { statusCode: domainError.httpStatus });
    audit.record("inference.forward_failed", {
      message,
      errorCode: domainError?.code,
      errorSource: domainError?.source,
      httpStatus: domainError?.httpStatus,
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
    failInferenceStatus(statusKey, globallyDisabled ?? message, generation);
    if (generation === inferenceGeneration) notifyStatusChanged();
    throw error;
  } finally {
    discardResponseBody(response);
  }
}

const PUBLIC_INFERENCE_ERROR_CODES = new Set([
  "authentication_required",
  "principal_forbidden",
  "policy_denied",
  "plaintext_not_enabled",
  "assurance_unavailable",
  "attestation_failed",
  "key_expired",
  "grant_expired",
  "replay_detected",
  "credit_exhausted",
  "capacity_exhausted",
  "provider_unavailable",
  "deadline_exceeded",
  "request_cancelled",
]);

/** Seat, member cap, or plan refusal (`inferenceAccessBlockReason`). */
function accessBlockReason(error: ProviderInferenceError): InferenceAccessBlockReason | null {
  return inferenceAccessBlockReason(error.code, error.message);
}

class ProviderInferenceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderInferenceError";
  }
}

async function inferenceHttpError(response: Response): Promise<ProviderInferenceError> {
  let raw = "";
  try { raw = (await response.text()).slice(0, 16_000); } catch { /* Use the status fallback below. */ }
  let providerCode: string | null = null;
  let providerMessage: string | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const nested = record.error && typeof record.error === "object" && !Array.isArray(record.error)
        ? record.error as Record<string, unknown>
        : null;
      const code = nested?.code ?? record.code;
      const message = nested?.message ?? record.message;
      providerCode = typeof code === "string" && code.trim() ? code.trim() : null;
      providerMessage = typeof message === "string" && message.trim() ? message.trim() : null;
    }
  } catch {
    providerMessage = raw.trim() || null;
  }
  const fallbackCode = response.status === 401 ? "authentication_required"
    : response.status === 402 ? "credit_exhausted"
      : response.status === 403 ? "policy_denied"
        : response.status === 408 || response.status === 504 ? "deadline_exceeded"
          : response.status === 429 ? "capacity_exhausted"
            : "provider_unavailable";
  const code = providerCode && PUBLIC_INFERENCE_ERROR_CODES.has(providerCode)
    ? providerCode
    : fallbackCode;
  const statusText = response.statusText.trim();
  const detail = providerMessage?.replace(/[\u0000-\u001f\u007f]+/gu, " ").slice(0, 320);
  return new ProviderInferenceError(
    code,
    response.status,
    detail || `Inference request failed (${response.status}${statusText ? ` ${statusText}` : ""}).`,
  );
}

function isProviderInferenceError(error: unknown): boolean {
  return inferenceDomainError(error) !== null
    || error instanceof BridgeGloballyDisabledError
    || (error instanceof ProviderInferenceError && error.code !== "authentication_required");
}

async function resolveInferenceNodeRoute(): Promise<CloudNodeRoute> {
  const session = await readSignedInSession();
  if (!session) throw new Error("Bridge is not signed in.");
  const active = shouldRefreshWorkOsSession(session)
    ? await refreshInferenceSessionIfNeeded(session)
    : session;
  if (active.kind !== "signed_in") throw new Error("Bridge is not signed in.");
  const route = await Effect.runPromise(cloudNodeRouting.resolve(active));
  const inferenceRoute = inferenceRouteFromAssignment(route);
  if (!inferenceRoute.capabilities.includes("inference") || !inferenceRoute.entitlements.inference) {
    throw new Error("Alexandria Node inference is not enabled for this workspace.");
  }
  return inferenceRoute;
}

function nodeSecureClient(baseUrl: string): BridgeSecureClientShape {
  const normalized = baseUrl.replace(/\/+$/, "");
  const cached = nodeSecureClients.get(normalized);
  if (cached) return cached;
  const created = createBridgeSecureClient({ serverBaseUrl: normalized });
  nodeSecureClients.set(normalized, created);
  return created;
}

async function refreshInferenceUsageCircuit(): Promise<void> {
  const snapshot = await usageSnapshotPayload(true);
  if (snapshot.state === "ready") notifyStatusChanged();
}

async function refreshExhaustedAccountCircuit(): Promise<void> {
  const session = await sessionStore().read();
  if (session.kind !== "signed_in") return;
  if (inferenceAvailability.snapshot(sessionUsageOwnerKey(session)).state !== "account_exhausted") return;
  await refreshInferenceUsageCircuit();
}

async function usageSnapshotPayload(force: boolean): Promise<import("@ambient/shared/usage").UsageSnapshot> {
  const stored = await sessionStore().read();
  const session = stored.kind === "signed_in" ? stored : null;
  const snapshot = await bridgeUsageCache.read({
    session,
    force,
    load: (activeSession) => bridgeUsageService.summary(activeSession),
  });
  if (snapshot.state === "ready") inferenceAvailability.observeSummary(snapshot.summary);
  return snapshot;
}

async function usagePricingPayload(force: boolean): Promise<import("@ambient/shared/usage").UsagePricingCatalog> {
  const stored = await sessionStore().read();
  const session = stored.kind === "signed_in" ? stored : null;
  return bridgePricingCache.read({
    session,
    force,
    load: (activeSession) => authServer.usagePricing(activeSession.sessionToken),
  });
}

async function usageModelBreakdownPayload(): Promise<import("@ambient/shared/usage").UsageModelBreakdown> {
  const stored = await sessionStore().read();
  if (stored.kind !== "signed_in") {
    throw new Error("Sign in to view account usage breakdown.");
  }
  return authServer.usageModelBreakdown(stored.sessionToken);
}

async function usageInstanceHistoryPayload(): Promise<
  readonly import("@ambient/shared/usage").UsageInstanceHistoryEntry[]
> {
  const stored = await sessionStore().read();
  if (stored.kind !== "signed_in") {
    throw new Error("Sign in to view local inference usage history.");
  }
  return networkHistory.list().map((entry) => ({
    requestId: entry.requestId,
    modelId: entry.model,
    route: entry.path,
    status: entry.status,
    statusCode: entry.statusCode,
    completedAt: entry.completedAt,
    usage: entry.usage,
  }));
}

const ANNOUNCEMENTS_CACHE_TTL_MS = 60_000;
let announcementsCache: {
  readonly organizationId: string | null;
  readonly document: import("@ambient/shared/announcements").AppAnnouncementsDocument;
  readonly fetchedAtMs: number;
} | null = null;
let announcementsInFlight: {
  readonly organizationId: string | null;
  readonly pending: Promise<import("@ambient/shared/announcements").AppAnnouncementsDocument>;
} | null = null;

async function announcementsSnapshotPayload(
  force: boolean,
): Promise<import("@ambient/shared/announcements").AppAnnouncementsDocument> {
  const stored = await sessionStore().read();
  const organizationId = stored.kind === "signed_in" && stored.organizationId
    ? stored.organizationId
    : null;
  const nowMs = Date.now();
  if (
    !force
    && announcementsCache
    && announcementsCache.organizationId === organizationId
    && nowMs - announcementsCache.fetchedAtMs < ANNOUNCEMENTS_CACHE_TTL_MS
  ) {
    return announcementsCache.document;
  }
  if (!force && announcementsInFlight?.organizationId === organizationId) {
    return announcementsInFlight.pending;
  }
  const pending = authServer.announcements({ organizationId })
    .then((document) => {
      announcementsCache = { organizationId, document, fetchedAtMs: Date.now() };
      return document;
    })
    .finally(() => {
      if (announcementsInFlight?.pending === pending) announcementsInFlight = null;
    });
  announcementsInFlight = { organizationId, pending };
  return pending;
}

async function inferenceModelsSnapshotPayload(
  force: boolean,
): Promise<import("@ambient/shared/inference-models").InferenceModelsSnapshot> {
  const stored = await sessionStore().read();
  const session = stored.kind === "signed_in" ? stored : null;
  return bridgeModelAssignmentCache.read({
    session,
    force,
    load: (activeSession) => authServer.inferenceModels(activeSession.sessionToken),
  });
}

/** The account's inference plan, or null (signed out, or a Cloud that predates it). */
async function inferencePlanSnapshotPayload(force: boolean): Promise<BridgeInferencePlanSnapshot | null> {
  const stored = await sessionStore().read();
  return bridgeInferencePlanCache.read(stored.kind === "signed_in" ? stored : null, { force });
}

async function usageTopupOptionsPayload(customAmounts: boolean): Promise<import("@ambient/shared/usage").UsageTopupOptions> {
  const stored = await sessionStore().read();
  if (stored.kind !== "signed_in") {
    throw new Error("Sign in to view credit top-up options.");
  }
  return authServer.usageTopupOptions(stored.sessionToken, customAmounts);
}

/**
 * Billing calls (ADR-0243). A change that can unblock inference (card added,
 * limit raised, mode switched) refreshes the usage circuit right away so a
 * paused account resumes without waiting for the next poll.
 */
async function usageBillingPayload<T>(
  call: (sessionToken: string) => Promise<T>,
  options: { readonly mutates?: boolean } = {},
): Promise<T> {
  const stored = await sessionStore().read();
  if (stored.kind !== "signed_in") {
    throw new Error("Sign in to manage billing.");
  }
  const result = await call(stored.sessionToken);
  if (options.mutates) {
    void refreshInferenceUsageCircuit().catch(() => undefined);
  }
  return result;
}

function spendingLimitPayload(payload: unknown): import("@ambient/shared/usage").UsageSpendingLimit | null {
  const limit = payload && typeof payload === "object" && "limit" in payload ? (payload as { limit: unknown }).limit : undefined;
  if (limit === null) return null;
  if (!limit || typeof limit !== "object") throw new Error("A spending limit or null is required.");
  const { amountMicros, period } = limit as { amountMicros?: unknown; period?: unknown };
  if (typeof amountMicros !== "string" || !/^[1-9][0-9]{0,18}$/.test(amountMicros)) {
    throw new Error("Spending limit amount is invalid.");
  }
  if (period !== "day" && period !== "week" && period !== "month") throw new Error("Spending limit period is invalid.");
  return { amountMicros, period };
}

async function usageCreateTopupCheckoutPayload(
  input: unknown,
): Promise<import("@ambient/shared/usage").UsageTopupCheckoutResponse> {
  const request = usageTopupCheckoutRequestSchema.parse(input);
  const stored = await sessionStore().read();
  if (stored.kind !== "signed_in") {
    throw new Error("Sign in to add inference credit.");
  }
  return authServer.createUsageTopupCheckout(stored.sessionToken, request);
}

/**
 * Subscription plans for people without an organization (ADR-0324). An
 * active plan clears a `plan_required` block right away, so a checkout
 * finished in the browser resumes processing without waiting for it to expire.
 */
async function plansListPayload(): Promise<import("@alexandria/cloud-contract/plans").AccountPlansResponse> {
  const session = await signedInPlansSession();
  const plans = await authServer.accountPlans(session.sessionToken);
  if (plans.subscription?.active) {
    const ownerKey = sessionUsageOwnerKey(session);
    if (inferenceAvailability.snapshot(ownerKey).state === "plan_required") {
      inferenceAvailability.accessRestored(ownerKey, "plan_required");
      statusEvents.emit("changed");
    }
  }
  return plans;
}

async function planCheckoutPayload(planId: string | null): Promise<import("@alexandria/cloud-contract/plans").PlanCheckoutResponse> {
  if (!planId) throw new Error("planId is required.");
  const session = await signedInPlansSession();
  return authServer.createPlanCheckout(session.sessionToken, planId);
}

async function planPortalPayload(): Promise<import("@alexandria/cloud-contract/plans").PlanPortalResponse> {
  const session = await signedInPlansSession();
  return authServer.createPlanPortal(session.sessionToken);
}

async function signedInPlansSession(): Promise<SignedInWorkOsSession> {
  const stored = await sessionStore().read();
  if (stored.kind !== "signed_in") throw new Error("Sign in to manage your plan.");
  return stored;
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

async function forwardSupportFeedbackToCloud(frame: BridgeRequestFrame): Promise<JsonValue> {
  return forwardSupportFeedback(frame.id, frame.payload, {
    audit,
    onUnauthorized: clearInvalidStoredSession,
    onResponse: storeRotatedSessionToken,
    readSession: () => sessionStore().read(),
    refreshSession: refreshInferenceSessionIfNeeded,
    serverBaseUrl,
  });
}

function multiplayerForwardOptions() {
  return {
    audit,
    multiplayerBaseUrl,
    resolveRoute: (session: SignedInWorkOsSession) => Effect.runPromise(cloudNodeRouting.resolve(session)),
    onNodeUnauthorized: () => Effect.runPromise(cloudNodeRouting.invalidate()),
    onUnauthorized: clearInvalidStoredSession,
    onResponse: storeRotatedSessionToken,
    readSession: () => sessionStore().read(),
    refreshSession: refreshInferenceSessionIfNeeded,
    appVersion: app.getVersion(),
  };
}

async function multiplayerRoutingStatusPayload() {
  const snapshot = await Effect.runPromise(cloudNodeRouting.snapshot());
  return {
    configured: snapshot.state === "ready" || snapshot.state === "legacy",
    origin: snapshot.origin,
    state: snapshot.state,
    organizationId: snapshot.organizationId,
    capabilities: snapshot.capabilities,
    inferenceMode: snapshot.inferenceMode,
    configurationVersion: snapshot.configurationVersion,
    message: snapshot.message,
  };
}
/**
 * Last-resort handler for Bridge process errors. Always audits locally
 * (bridge-audit.jsonl); a fatal exception additionally persists a local crash
 * marker and 30s window. Never rethrows — diagnostics must not take Bridge down.
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
  } catch {
    // Nothing else we can safely do while handling a process-level error.
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
    void refreshOrgPolicy("session_refresh", { force: options.force === true || authStatusChanged });
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

  const current = await readSignedInSession();
  if (!current) return;
  await storeRotatedSessionTokenValue(sessionToken, current);
}

async function storeRotatedSessionTokenValue(
  sessionToken: string,
  expectedSession: SignedInWorkOsSession,
): Promise<void> {
  try {
    const authSession = await authServer.validateSession(sessionToken);
    const nextSession = withCachedCurrentOrganizationFeatureFlags(
      toStoredSession(authSession, expectedSession),
      { overwrite: true },
    );
    const wrote = await writeSignedInSessionIfCurrent(nextSession, expectedSession, "session_rotation");
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
    expiresAt: workOsSessionExpiresAtSeconds(authSession.expiresAt),
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
  ownsCurrent?: (session: SignedInWorkOsSession) => boolean,
): Promise<boolean> {
  const result = await sessionStore().writeIfCurrent(nextSession, expectedSession, ownsCurrent);
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

async function signInViaIpc(options: { restart?: boolean; reopen?: boolean } = {}): Promise<JsonValue> {
  const session = await readSignedInSession();
  if (session) {
    return { status: "already_signed_in" };
  }
  await startLoginFlow({ ...options, showBridgeOnCompletion: false });
  return { status: "login_started" };
}

async function switchOrganization(
  organizationId: string,
  options: { readonly showBridgeOnCompletion?: boolean } = {},
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
    void refreshOrgPolicy("organization_switch", { force: true });
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
      await startLoginFlow({
        organizationId,
        showBridgeOnCompletion: options.showBridgeOnCompletion === true,
      });
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
  inferenceAdmissions.clear();
  inferenceGeneration += 1;
  activeInferenceRequests.abortAll("inference_boundary_changed");
  activeAttestationChecks.clear();
  networkHistory.clear();
  wireTap.clear();
  inferenceStatus = initialInferenceStatus();
  inferenceAvailability.clearAccount();
  bridgeUsageCache.clear();
  bridgeModelAssignmentCache.clear();
  bridgeInferencePlanCache.clear();
  bridgeOrgPolicyCache.clear();
  bridgePricingCache.clear();
  Effect.runSync(cloudNodeRouting.invalidate());
  publishRequestLogReset();
  notifyStatusChanged();
}

/**
 * Fetches the user's organization memberships from the server and persists
 * them on the stored session so the status payload (and both app UIs) can
 * render the org switcher without extra round-trips. Best-effort: callers
 * fire-and-forget; failures keep the previous directory.
 */
async function refreshOrganizations(): Promise<void> {
  try {
    const generation = inferenceGeneration;
    const session = await readSignedInSession();
    if (!session || generation !== inferenceGeneration) return;
    const boundaryKey = cloudNodeSessionBoundaryKey(session);
    if (organizationsRefresh?.generation === generation) {
      const active = organizationsRefresh;
      if (active.boundaryKey === boundaryKey) return active.pending;
      await active.pending;
      if (generation === inferenceGeneration) return refreshOrganizations();
      return;
    }
    const pending: Promise<void> = refreshOrganizationsOnce(session, generation, (current) =>
      organizationsRefresh?.pending === pending
      && generation === inferenceGeneration
      && cloudNodeSessionBoundaryKey(current) === boundaryKey,
    ).catch(recordOrganizationsRefreshFailure).finally(() => {
      if (organizationsRefresh?.pending === pending) organizationsRefresh = null;
    });
    organizationsRefresh = { generation, boundaryKey, pending };
    return pending;
  } catch (error) {
    recordOrganizationsRefreshFailure(error);
  }
}

function recordOrganizationsRefreshFailure(error: unknown): void {
  audit.record("auth.organizations_refresh_failed", {
    message: safeStatusMessage(errorMessage(error)),
  });
}

async function refreshOrganizationsOnce(
  session: SignedInWorkOsSession,
  generation: number,
  ownsCurrent: (session: SignedInWorkOsSession) => boolean,
): Promise<void> {
  const response = await authServer.listOrganizations(session.sessionToken, { includeFeatureFlags: true });
  // Token refresh can rebase within this request's account/organization boundary.
  const current = await readSignedInSession();
  if (!current || !ownsCurrent(current)) return;

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
  const wrote = await writeSignedInSessionIfCurrent(nextSession, current, "organizations_refresh", ownsCurrent);
  const committed = sessionStore().peekCached();
  if (
    !wrote || generation !== inferenceGeneration || committed?.kind !== "signed_in"
    || cloudNodeSessionBoundaryKey(committed) !== cloudNodeSessionBoundaryKey(nextSession)
  ) return;
  if (cloudNodeSessionBoundaryKey(current) !== cloudNodeSessionBoundaryKey(nextSession)) {
    clearInferenceTransparency();
  }
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

/**
 * Fetches the org policy for the stored session (sign-in, org switch, session
 * refresh via status reads, and a 60s poll). Failures keep the last good policy.
 */
async function refreshOrgPolicy(reason: string, options: { readonly force?: boolean } = {}): Promise<void> {
  try {
    const session = await readSignedInSession();
    await bridgeOrgPolicyCache.refresh(
      session ? { organizationId: session.organizationId ?? null, sessionToken: session.sessionToken } : null,
      options,
    );
  } catch (error) {
    audit.record("org_policy.refresh_failed", { reason, message: safeStatusMessage(errorMessage(error)) });
  }
}

function publicFeatureFlags(session: SignedInWorkOsSession): BridgeFeatureFlags {
  // A known policy for this exact organization decides registry features
  // (ADR-0295); otherwise the WorkOS slugs apply unchanged.
  // Global controls (ADR-0296) then remove killed features, with or without a policy.
  const enabledSlugs = withoutGloballyDisabledSlugs(
    orgPolicyFeatureSlugs(
      sessionFeatureFlagSlugs(session),
      bridgeOrgPolicyCache.policyFor(session.organizationId)?.policy ?? null,
    ),
    bridgeOrgPolicyCache.globalControlsFor(session.organizationId),
    session.organizationId ?? null,
    Date.now(),
  );
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
    ...assistantFeatureCapabilities(enabledSlugs),
  };
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
    channel: input.channel,
    isPackaged: app.isPackaged,
    localQaBuild: isLocalQaBuild(),
    platform: process.platform,
    version: input.version,
  });
  const baseUrl = bridgeUpdateBaseUrlFromEnv();
  const feedUrl = reason
    ? null
    : bridgeUpdateFeedUrl({
      arch: process.arch,
      baseUrl,
      channel: input.channel,
      platform: process.platform,
      version: input.version,
    });
  const releaseNotesUrl = reason
    ? null
    : bridgeChangelogUrl({
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
  // Local packaged builds pin installer versions to X.Y.Z-local.<timestamp>,
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

function currentShellAccountSignature(): string {
  if (pendingLogin) return "login_pending";
  if (bridgeUiE2eWireUrl()) {
    return authStatusSnapshotSignature(publicAccountState(bridgeUiE2eSession()));
  }
  const cached = workOsSessionStore?.peekCached();
  if (!cached) return lastAuthStatusSnapshotSignature ?? "unknown";
  return authStatusSnapshotSignature(publicAccountState(cached));
}

function currentShellStatusSignature(): string {
  const reachability = serverReachability.current();
  const sessionRefresh = sessionRefreshCoordinator.snapshot();
  const nodeRouting = Effect.runSync(cloudNodeRouting.snapshot());
  const latest = networkHistory.latest();
  const pendingPairingRequests = pairingStore.listRequests()
    .filter((request) => request.status === "pending").length;
  const pairedClients = pairingStore.listClients()
    .filter((client) => !client.credential.revokedAt).length;
  const cachedSession = bridgeUiE2eWireUrl()
    ? bridgeUiE2eSession()
    : workOsSessionStore?.peekCached();
  const inferenceAvailabilitySnapshot = cachedSession?.kind === "signed_in"
    ? inferenceAvailability.snapshot(sessionUsageOwnerKey(cachedSession))
    : inferenceAvailability.snapshot();
  return bridgeShellStatusSignature({
    accountSignature: currentShellAccountSignature(),
    activeRequests: activeInferenceRequests.size,
    attestation: inferenceStatus.attestation,
    attestationInProgress: activeAttestationChecks.size > 0,
    authError: authError ?? "",
    lastError: inferenceStatus.lastError ?? "",
    lastRequestId: latest?.requestId ?? "",
    lastRequestStatus: latest?.status ?? "",
    loginPending: Boolean(pendingLogin),
    plaintextInferenceWarningHidden,
    inferenceAvailability: inferenceAvailabilitySnapshot,
    nodeRouting,
    orgPolicy: shellOrgPolicySignatureInput(bridgeOrgPolicyCache.snapshot(
      cachedSession?.kind === "signed_in" ? cachedSession.organizationId ?? null : null,
    )),
    pairedClients,
    pendingPairingRequests,
    reachability: reachability.state,
    sessionRefreshAttempt: sessionRefresh.attempt,
    sessionRefreshState: sessionRefresh.state,
    socketReady: Boolean(ipcServer),
    wireCaptureRevision: inferenceStatus.wireCaptureRevision,
  });
}

function shellOrgPolicySignatureInput(status: BridgeOrgPolicyStatus) {
  return { ...status, globalControlsSignature: globalControlsSignature(status.globalControls) };
}

function notifyStatusChanged(): void {
  const signature = currentShellStatusSignature();
  if (signature === lastShellStatusSignature) return;
  lastShellStatusSignature = signature;
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
  requestShowMainWindow("show_main_window");
}

function liveMainWindow(): BrowserWindow | null {
  return windowLifecycle.liveWindow() as BrowserWindow | null;
}
