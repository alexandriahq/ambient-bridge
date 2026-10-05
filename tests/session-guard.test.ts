import { describe, expect, it } from "vitest";
import type { BridgeStatus } from "../src/lib/bridge-api";
import {
  BRIDGE_GUARD_ACTION_RETRY_REACHABILITY,
  BRIDGE_GUARD_ACTION_SIGN_IN,
  composeBridgeSessionGuard,
} from "../src/lib/session-guard";

describe("composeBridgeSessionGuard", () => {

  it("preserves network labels, fallback copy, and custom-detail trimming", () => {
    const cases = [
      ["offline", "Offline", "Bridge could not find an internet route to the Ambient server."],
      ["dns_failure", "DNS failed", "Bridge could not resolve the Ambient server hostname."],
      ["server_error", "Server down", "The Ambient server health check did not return a healthy response."],
      ["timeout", "Timed out", "The Ambient server health check took too long to respond."],
      ["not_checked", "Not checked", "Bridge could not reach the Ambient server."],
      ["network_error", "Unreachable", "Bridge could not reach the Ambient server."],
      ["ok", "Unreachable", "Bridge could not reach the Ambient server."],
    ] as const;
    for (const [reason, label, fallback] of cases) {
      for (const detail of ["", "  \t ", "  Custom network detail.  "]) {
        const guard = composeBridgeSessionGuard({
          status: bridgeStatus({
            serverReachability: "unavailable",
            serverReachabilityMessage: detail,
            serverReachabilityReason: reason,
          }),
        });
        expect(guard).toMatchObject({ blocking: true, reason: "network" });
        expect(guard.model).toMatchObject({ message: detail?.trim() || fallback, statusLabel: label });
        expect(guard.model?.rows).toContainEqual(expect.objectContaining({ id: "server", value: label }));
        if (reason === "network_error") expect(guard.model?.title).toBe("Bridge cannot reach Ambient server");
        if (reason === "dns_failure") expect(guard.model?.nextSteps?.[1]).toBe("Try again after the server hostname resolves.");
      }
    }
  });

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
          skills: false, reports: false,
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
      responsePrivacy: "decrypts_in_bridge",
      serverAuth: "workos_session",
      serverOrigin: "https://api.example.test",
      wireCaptureRevision: 0,
    },
    plaintextInferenceWarningHidden: false,
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
