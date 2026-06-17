export type BridgeView = "network" | "overview";

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
  | "proxy_unavailable"
  | "attestation_invalid"
  | "offline";

export type BridgeServerReachabilityState = "checking" | "reachable" | "unavailable";

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

export type BridgeWireHeader = { name: string; value: string };

export type BridgeWireBody = {
  base64: string;
  capturedBytes: number;
  byteLength: number | null;
  truncated: boolean;
};

export type BridgeWireCapture = {
  requestId: string;
  at: number;
  request: {
    method: string;
    url: string;
    headers: BridgeWireHeader[];
    body: BridgeWireBody;
  };
  response: {
    status: number;
    headers: BridgeWireHeader[];
    body: BridgeWireBody;
  } | null;
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
  updateAvailable: boolean;
  updateError?: string;
};

export type BridgeUiApi = {
  getStatus(): Promise<BridgeStatus>;
  getUpdateStatus(): Promise<BridgeUpdateStatus>;
  getWireCapture(requestId: string): Promise<BridgeWireCapture | null>;
  onStatusChanged(callback: () => void): () => void;
  onUpdateStatusChanged(callback: (status: BridgeUpdateStatus) => void): () => void;
  checkForUpdates(): Promise<BridgeUpdateStatus>;
  installUpdate(): Promise<BridgeUpdateStatus>;
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
