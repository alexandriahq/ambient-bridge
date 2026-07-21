import { describe, expect, it } from "vitest";
import type { BridgeStatus } from "../src/lib/bridge-api";
import {
  BRIDGE_GUARD_ACTION_RETRY_REACHABILITY,
  BRIDGE_GUARD_ACTION_SIGN_IN,
  composeBridgeSessionGuard,
} from "../src/lib/session-guard";

describe("composeBridgeSessionGuard", () => {
  it("blocks Bridge UI until the account is signed in", () => {
    const guard = composeBridgeSessionGuard({ status: bridgeStatus({ account: { kind: "signed_out" } }) });

    expect(guard).toMatchObject({ blocking: true, reason: "auth" });
    expect(guard.model?.title).toBe("Sign in to Ambient Bridge");
    expect(guard.model?.actions?.[0]).toMatchObject({ id: BRIDGE_GUARD_ACTION_SIGN_IN });
  });

  it("blocks Bridge UI while server reachability is still loading", () => {
    const guard = composeBridgeSessionGuard({
      status: bridgeStatus({
        serverReachability: "checking",
        serverReachabilityReason: "not_checked",
      }),
    });

    expect(guard).toMatchObject({ blocking: true, reason: "network" });
    expect(guard.model?.status).toBe("checking");
    expect(guard.model?.title).toBe("Checking server reachability");
  });

  it("shows an actionable network failure with retry", () => {
    const guard = composeBridgeSessionGuard({
      status: bridgeStatus({
        serverReachability: "unavailable",
        serverReachabilityMessage: "DNS lookup for the Ambient server failed.",
        serverReachabilityReason: "dns_failure",
      }),
    });

    expect(guard.model).toMatchObject({
      message: "DNS lookup for the Ambient server failed.",
      status: "failed",
      title: "DNS lookup failed",
    });
    expect(guard.model?.actions).toContainEqual(expect.objectContaining({
      id: BRIDGE_GUARD_ACTION_RETRY_REACHABILITY,
      label: "Try again",
    }));
  });

  it("allows the Bridge UI when auth, IPC, and network are ready", () => {
    expect(composeBridgeSessionGuard({ status: bridgeStatus() })).toEqual({
      blocking: false,
      model: null,
      reason: null,
    });
  });
});

function bridgeStatus(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    account: {
      email: "user@example.test",
      featureFlags: {
        capabilities: {
          automations: false,
          automationToggleTrack: false,
          contextHandoff: false,
          devtooling: false,
          integrations: false,
        },
        definitions: [],
        enabledSlugs: [],
        evaluatedFor: { organizationId: null, userId: "user_test" },
        sample: { enabled: false, slug: "devtools-visible" },
        source: "user",
      },
      kind: "signed_in",
    },
    activity: [],
    appVersion: "0.1.0-test",
    connection: "ready",
    inference: {
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
      serverOrigin: "https://api.example.test",
      wireCaptureRevision: 0,
    },
    pairedClientList: [],
    pairedClients: 0,
    pairingRequests: [],
    serverReachable: true,
    serverReachability: "reachable",
    serverReachabilityCheckedAt: 1_700_000_000_000,
    serverReachabilityHttpStatus: 200,
    serverReachabilityMessage: "Ambient server is reachable.",
    serverReachabilityReason: "ok",
    sessionRefresh: {
      attempt: 0,
      message: null,
      nextRetryAt: null,
      state: "ready",
    },
    socketReady: true,
    ...overrides,
  };
}
