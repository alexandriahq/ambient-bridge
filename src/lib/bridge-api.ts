import type {
  NetworkRequestRecord as BridgeInferenceRequestStatus,
  BridgeCopyWirePayloadResult,
  BridgeWireCaptureResult,
} from "../../electron/bridge-ui-contract.js";

export type {
  InferenceUsage as BridgeInferenceUsage,
  InferenceProxyPath as BridgeInferenceProxyPath,
  NetworkRequestRecord as BridgeInferenceRequestStatus,
  BridgeCopyWirePayloadResult,
  BridgeWireBody,
  BridgeWireCapture,
  BridgeWireCaptureResult,
  BridgeWireHeader,
} from "../../electron/bridge-ui-contract.js";

export type BridgeOrganization = {
  id: string;
  name: string;
};

export type BridgeFeatureFlags = {
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

export type BridgeFeatureFlagKey =
  | "integrations"
  | "automations"
  | "automationToggleTrack"
  | "devtooling"
  | "contextHandoff"
  | "skills"
  | "reports";

export type BridgeFeatureFlagFamily = "integrations" | "automations" | "devtools" | "context";

export type BridgeFeatureFlagDefinition = {
  key: BridgeFeatureFlagKey;
  slug: string;
  title: string;
  family: BridgeFeatureFlagFamily;
  description: string;
  requiresKey?: BridgeFeatureFlagKey;
};

export type BridgeFeatureFlagCapabilities = Record<BridgeFeatureFlagKey, boolean>;

export type BridgeAccountState =
  | { kind: "signed_out" }
  | { kind: "login_pending"; userCode?: string; verificationUri?: string }
  | {
      kind: "signed_in";
      email: string;
      name?: string;
      profilePictureUrl?: string;
      organizationId?: string;
      organizationName?: string;
      organizations?: BridgeOrganization[];
      featureFlags: BridgeFeatureFlags;
    };

export type BridgeConnectionState =
  | "ready"
  | "starting"
  | "checking"
  | "retrying"
  | "degraded"
  | "proxy_unavailable"
  | "attestation_invalid"
  | "offline";

export type BridgeServerReachabilityState = "checking" | "reachable" | "unavailable";

export type BridgeServerReachabilityReason =
  | "not_checked"
  | "ok"
  | "offline"
  | "dns_failure"
  | "timeout"
  | "server_error"
  | "network_error";

export type BridgeSessionRefreshSnapshot = {
  attempt: number;
  message: string | null;
  nextRetryAt: number | null;
  state: "ready" | "refreshing" | "retrying" | "degraded";
};

export type BridgePairingRequest = {
  id: string;
  clientName: string;
  requestedAt: number;
  status: "pending" | "approved" | "rejected";
};

export type BridgePairedClient = {
  id: string;
  name: string;
  pairedAt: number;
  revokedAt: number | null;
};

/** Shell inference fields only — never carry the request list. */
export type BridgeInferenceStatus = {
  activeRequests: number;
  attestation: "not_checked" | "verifying" | "verified" | "failed";
  attestationChecks: BridgeAttestationCheck[];
  attestationInProgress: boolean;
  encryption: "ehbp" | "none";
  lastError: string | null;
  lastRequest: BridgeInferenceRequestStatus | null;
  responsePrivacy: "decrypts_in_bridge";
  serverAuth: "workos_session";
  serverOrigin: string;
  wireCaptureRevision: number;
};

/** Initial newest-first page for the Bridge window network log. */
export type BridgeRequestLogSnapshot = {
  revision: number;
  requests: BridgeInferenceRequestStatus[];
};

/** Incremental network-log update; renderer merges by requestId. */
export type BridgeRequestLogPatch = {
  revision: number;
  upserts: BridgeInferenceRequestStatus[];
  removeIds?: string[];
  /** When true, drop the current list before applying upserts (sign-out / clear). */
  reset?: boolean;
};

export type BridgeAttestationCheck = {
  checkedAt: number;
  reason: string | null;
  requestId: string;
  status: "passed" | "failed";
};

/** Window shell + Ambient pairing snapshot. No request list / activity feed. */
export type BridgeStatus = {
  account: BridgeAccountState;
  authError?: string;
  connection: BridgeConnectionState;
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
  serverReachability: BridgeServerReachabilityState;
  serverReachabilityCheckedAt: number | null;
  serverReachabilityHttpStatus: number | null;
  serverReachabilityMessage: string;
  serverReachabilityReason: BridgeServerReachabilityReason;
  sessionRefresh: BridgeSessionRefreshSnapshot;
  appVersion: string;
  socketReady: boolean;
};

export type BridgeUpdateStatus = {
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

export type BridgeUiApi = {
  copyWirePayload(requestId: string): Promise<BridgeCopyWirePayloadResult>;
  getStatus(): Promise<BridgeStatus>;
  getRequestLog(): Promise<BridgeRequestLogSnapshot>;
  getUpdateStatus(): Promise<BridgeUpdateStatus>;
  getWireCapture(requestId: string): Promise<BridgeWireCaptureResult>;
  onStatusChanged(callback: () => void): () => void;
  onRequestLogChanged(callback: (patch: BridgeRequestLogPatch) => void): () => void;
  onUpdateStatusChanged(callback: (status: BridgeUpdateStatus) => void): () => void;
  checkForUpdates(): Promise<BridgeUpdateStatus>;
  checkForStableUpdates?(): Promise<BridgeUpdateStatus>;
  installUpdate(): Promise<BridgeUpdateStatus>;
  getUninstallAvailability(): Promise<{
    readonly available: boolean;
    readonly reason: string | null;
    readonly method: "trash" | "pkexec" | "nsis" | null;
  }>;
  uninstall(): Promise<{ readonly status: "uninstalled" }>;
  retryReachability(): Promise<BridgeStatus>;
  viewUpdateReleaseNotes(): Promise<boolean>;
  startLogin(options?: { restart?: boolean; reopen?: boolean }): Promise<void>;
  signOut(): Promise<void>;
  switchOrganization(organizationId: string): Promise<void>;
  completePairing(requestId: string, approved: boolean): Promise<BridgePairedClient | null>;
  revokeClient(clientId: string): Promise<void>;
};

declare global {
  interface Window {
    ambientBridge?: BridgeUiApi;
  }
}
