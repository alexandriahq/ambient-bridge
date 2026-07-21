import type {
  BridgeCopyWirePayloadResult,
  BridgeWireCaptureResult,
} from "../../electron/bridge-ui-contract.js";

export type {
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
  | "contextHandoff";

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

export type BridgeActivityEvent = {
  name: string;
  at: number;
  fields: Record<string, string | number | boolean | null>;
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

export type BridgeInferenceStatus = {
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

export type BridgeAttestationCheck = {
  checkedAt: number;
  reason: string | null;
  requestId: string;
  status: "passed" | "failed";
};

export type BridgeInferenceUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type BridgeInferenceProxyPath = "/v1/chat/completions" | "/v1/responses" | "/v1/audio/transcriptions";

export type BridgeInferenceRequestStatus = {
  completedAt: number | null;
  feature: string;
  model: string | null;
  path: BridgeInferenceProxyPath;
  requestId: string;
  startedAt: number;
  status: "active" | "completed" | "failed" | "cancelled";
  statusCode: number | null;
  requestBytes: number | null;
  encryption: "ehbp";
  attestation: "pending" | "verified" | "failed";
  ehbpResponseNonce: string | null;
  tinfoilRequestId: string | null;
  usage: BridgeInferenceUsage | null;
  error: string | null;
  wireCaptured: boolean;
};

export type BridgeStatus = {
  account: BridgeAccountState;
  activity: BridgeActivityEvent[];
  authError?: string;
  connection: BridgeConnectionState;
  inference: BridgeInferenceStatus;
  pairedClientList: BridgePairedClient[];
  pairedClients: number;
  pairingRequests: BridgePairingRequest[];
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

export type BridgeExperimentalBuildsSnapshot = {
  channel: string;
  platform: string;
  arch: string;
  currentVersion: string;
  releasesUrl: string | null;
  builds: readonly {
    id: string | null;
    releaseKey: string;
    version: string;
    channel: string;
    platform: string;
    arch: string;
    commitSha: string;
    notes: string | null;
    releasedAt: string;
  }[];
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
  getUpdateStatus(): Promise<BridgeUpdateStatus>;
  getWireCapture(requestId: string): Promise<BridgeWireCaptureResult>;
  onStatusChanged(callback: () => void): () => void;
  onUpdateStatusChanged(callback: (status: BridgeUpdateStatus) => void): () => void;
  checkForUpdates(): Promise<BridgeUpdateStatus>;
  checkForStableUpdates?(): Promise<BridgeUpdateStatus>;
  installUpdate(): Promise<BridgeUpdateStatus>;
  retryReachability(): Promise<BridgeStatus>;
  viewUpdateReleaseNotes(): Promise<boolean>;
  listExperimentalBuilds(): Promise<BridgeExperimentalBuildsSnapshot>;
  installExperimentalBuild(version: string): Promise<BridgeUpdateStatus>;
  startLogin(): Promise<void>;
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
