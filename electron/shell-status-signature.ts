/**
 * Compact signature of Bridge shell fields the window / Ambient clients care
 * about. Used to skip `bridge:status-changed` pings when only the request log
 * moved (log patches go out on their own channel).
 */
export type BridgeShellStatusSignatureInput = {
  readonly accountSignature: string;
  readonly activeRequests: number;
  readonly attestation: string;
  readonly attestationInProgress: boolean;
  readonly authError: string;
  readonly lastError: string;
  readonly lastRequestId: string;
  readonly lastRequestStatus: string;
  readonly loginPending: boolean;
  readonly plaintextInferenceWarningHidden: boolean;
  readonly inferenceAvailability: {
    readonly state: string;
    readonly ownerKey?: string | null;
    readonly updatedAt?: string | null;
    readonly code?: string | null;
    readonly retryAtMs?: number | null;
  };
  readonly nodeRouting: {
    readonly state: string;
    readonly organizationId: string | null;
    readonly workspaceId: string | null;
    readonly workspaceKind: string | null;
    readonly installationId: string | null;
    readonly origin: string | null;
    readonly capabilities: readonly string[];
    readonly entitlements: {
      readonly inference: boolean;
      readonly multiplayer: boolean;
      readonly publishing: boolean;
      readonly mcp: boolean;
    };
    readonly inferenceMode: string | null;
    readonly configurationVersion: number | null;
    readonly message: string | null;
  };
  readonly orgPolicy?: {
    readonly state: string;
    readonly evaluatedFor: { readonly organizationId: string | null };
    readonly policy: { readonly version: number; readonly publishedAt: string } | null;
    /** Pre-computed `globalControlsSignature` of the active global controls (ADR-0296). */
    readonly globalControlsSignature?: string;
  };
  readonly pairedClients: number;
  readonly pendingPairingRequests: number;
  readonly reachability: string;
  readonly sessionRefreshAttempt: number;
  readonly sessionRefreshState: string;
  readonly socketReady: boolean;
  readonly wireCaptureRevision: number;
};

export function bridgeShellStatusSignature(input: BridgeShellStatusSignatureInput): string {
  return [
    input.accountSignature,
    input.loginPending ? "1" : "0",
    input.authError,
    input.socketReady ? "1" : "0",
    input.reachability,
    input.sessionRefreshState,
    String(input.sessionRefreshAttempt),
    String(input.activeRequests),
    input.attestation,
    input.attestationInProgress ? "1" : "0",
    input.lastError,
    input.lastRequestId,
    input.lastRequestStatus,
    String(input.wireCaptureRevision),
    input.plaintextInferenceWarningHidden ? "1" : "0",
    inferenceAvailabilitySignature(input.inferenceAvailability),
    nodeRoutingSignature(input.nodeRouting),
    orgPolicySignature(input.orgPolicy),
    String(input.pairedClients),
    String(input.pendingPairingRequests),
  ].join("|");
}

function inferenceAvailabilitySignature(
  input: BridgeShellStatusSignatureInput["inferenceAvailability"],
): string {
  return [
    input.state,
    input.ownerKey ?? "",
    input.updatedAt ?? "",
    input.code ?? "",
    input.retryAtMs == null ? "" : String(input.retryAtMs),
  ].join("~");
}

/** fetchedAt is excluded: a 304 every poll must not wake every client. */
function orgPolicySignature(input: BridgeShellStatusSignatureInput["orgPolicy"]): string {
  if (!input) return "";
  return [
    input.state,
    input.evaluatedFor.organizationId ?? "",
    input.policy ? String(input.policy.version) : "",
    input.policy?.publishedAt ?? "",
    input.globalControlsSignature ?? "",
  ].join("~");
}

function nodeRoutingSignature(input: BridgeShellStatusSignatureInput["nodeRouting"]): string {
  return [
    input.state,
    input.organizationId ?? "",
    input.workspaceId ?? "",
    input.workspaceKind ?? "",
    input.installationId ?? "",
    input.origin ?? "",
    [...input.capabilities].sort().join(","),
    input.entitlements.inference ? "1" : "0",
    input.entitlements.multiplayer ? "1" : "0",
    input.entitlements.publishing ? "1" : "0",
    input.entitlements.mcp ? "1" : "0",
    input.inferenceMode ?? "",
    input.configurationVersion === null ? "" : String(input.configurationVersion),
    input.message ?? "",
  ].join("~");
}
