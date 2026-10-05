import { describe, expect, it } from "vitest";
import { bridgeShellStatusSignature } from "./shell-status-signature.js";

const base = {
  accountSignature: "signed_in|org",
  activeRequests: 1,
  attestation: "verified",
  attestationInProgress: false,
  authError: "",
  lastError: "",
  lastRequestId: "req-1",
  lastRequestStatus: "active",
  loginPending: false,
  plaintextInferenceWarningHidden: false,
  inferenceAvailability: { state: "ready" },
  nodeRouting: {
    state: "ready",
    organizationId: null,
    workspaceId: "ws_personal_user_1",
    workspaceKind: "personal",
    installationId: "installation_public",
    origin: "https://node.alexandria.so",
    capabilities: ["inference"],
    entitlements: { inference: true, multiplayer: false, publishing: false, mcp: false },
    inferenceMode: "plaintext",
    configurationVersion: 1,
    message: null,
  },
  pairedClients: 1,
  pendingPairingRequests: 0,
  reachability: "reachable",
  sessionRefreshAttempt: 0,
  sessionRefreshState: "ready",
  socketReady: true,
  wireCaptureRevision: 3,
} as const;

describe("bridgeShellStatusSignature", () => {
  it("is stable when only non-shell request-log fields would have changed", () => {
    expect(bridgeShellStatusSignature(base)).toBe(bridgeShellStatusSignature({ ...base }));
  });

  it("changes when active request count or last error changes", () => {
    const idle = bridgeShellStatusSignature({ ...base, activeRequests: 0, lastRequestStatus: "completed" });
    const errored = bridgeShellStatusSignature({ ...base, lastError: "upstream failed" });
    expect(idle).not.toBe(bridgeShellStatusSignature(base));
    expect(errored).not.toBe(bridgeShellStatusSignature(base));
  });

  it("changes when the plaintext warning developer override changes", () => {
    const hidden = bridgeShellStatusSignature({
      ...base,
      plaintextInferenceWarningHidden: true,
    });
    expect(hidden).not.toBe(bridgeShellStatusSignature(base));
  });

  it("changes immediately when inference credit is exhausted", () => {
    const exhausted = bridgeShellStatusSignature({
      ...base,
      inferenceAvailability: {
        state: "account_exhausted",
        ownerKey: "organization:org_a",
        updatedAt: "2026-09-03T10:00:00.000Z",
      },
    });
    expect(exhausted).not.toBe(bridgeShellStatusSignature(base));
  });

  it("changes for each Cloud Node routing transition and assignment boundary", () => {
    const unknown = bridgeShellStatusSignature({
      ...base,
      nodeRouting: {
        ...base.nodeRouting,
        state: "unknown",
        workspaceId: null,
        workspaceKind: null,
        installationId: null,
        origin: null,
        capabilities: [],
        entitlements: { inference: false, multiplayer: false, publishing: false, mcp: false },
        inferenceMode: null,
        configurationVersion: null,
      },
    });
    const resolving = bridgeShellStatusSignature({
      ...base,
      nodeRouting: {
        ...base.nodeRouting,
        state: "resolving",
        workspaceId: null,
        workspaceKind: null,
        installationId: null,
        origin: null,
        capabilities: [],
        entitlements: { inference: false, multiplayer: false, publishing: false, mcp: false },
        inferenceMode: null,
        configurationVersion: null,
      },
    });
    const ready = bridgeShellStatusSignature(base);
    const reconfigured = bridgeShellStatusSignature({
      ...base,
      nodeRouting: { ...base.nodeRouting, installationId: "installation_public_2", configurationVersion: 2 },
    });

    expect(new Set([unknown, resolving, ready, reconfigured])).toHaveLength(4);
  });
});
