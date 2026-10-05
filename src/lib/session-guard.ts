import {
  networkMessage,
  networkStatusLabel,
  type SessionGuardCardModel,
  type SessionGuardRow,
  type SessionGuardStatus,
} from "@ambient/shared";
import type { BridgeServerReachabilityReason, BridgeStatus } from "./bridge-api";

export const BRIDGE_GUARD_ACTION_CHECK_STATUS = "bridge.checkStatus";
export const BRIDGE_GUARD_ACTION_RETRY_REACHABILITY = "bridge.retryReachability";
export const BRIDGE_GUARD_ACTION_SIGN_IN = "bridge.signIn";
export const BRIDGE_GUARD_ACTION_RESTART_SIGN_IN = "bridge.restartSignIn";

export type BridgeSessionGuardState = {
  readonly blocking: boolean;
  readonly model: SessionGuardCardModel | null;
  readonly reason: "auth" | "network" | "ipc" | null;
};

export function composeBridgeSessionGuard(input: {
  readonly authBusy?: boolean;
  readonly loading?: boolean;
  readonly status: BridgeStatus;
}): BridgeSessionGuardState {
  const { status } = input;
  const account = status.account;

  if (account.kind !== "signed_in") {
    const pending = account.kind === "login_pending";
    return blocked("auth", {
      actions: pending
        ? [
            {
              busy: input.authBusy,
              id: BRIDGE_GUARD_ACTION_RESTART_SIGN_IN,
              label: input.authBusy ? "Opening browser" : "Restart sign-in",
            },
            {
              busy: input.loading,
              id: BRIDGE_GUARD_ACTION_CHECK_STATUS,
              label: "Check status",
              variant: "secondary",
            },
          ]
        : [
            {
              busy: input.authBusy,
              id: BRIDGE_GUARD_ACTION_SIGN_IN,
              label: input.authBusy ? "Opening browser" : "Sign in",
            },
            {
              busy: input.loading,
              id: BRIDGE_GUARD_ACTION_CHECK_STATUS,
              label: "Check status",
              variant: "secondary",
            },
          ],
      detail: status.authError ?? null,
      message: pending
        ? "Bridge is waiting for the WorkOS callback from your browser. Restart sign-in if the browser closed or got stuck."
        : "Bridge owns Ambient account auth and stays locked until this device is signed in.",
      nextSteps: pending
        ? ["Finish the browser sign-in window.", "If nothing happens, restart sign-in from this card."]
        : ["Sign in with your Ambient account.", "Keep Bridge running so Ambient can use its authenticated network egress."],
      rows: [
        accountRow(pending ? "Browser sign-in pending" : "Signed out", pending ? "checking" : "needs_action"),
        serverRow(status),
        ipcRow(status),
      ],
      status: pending ? "checking" : "needs_action",
      statusLabel: pending ? "Waiting for sign-in" : "Account required",
      title: pending ? "Complete Bridge sign-in" : "Sign in to Ambient Bridge",
    });
  }

  if (!status.socketReady) {
    return blocked("ipc", {
      actions: [
        {
          busy: input.loading,
          id: BRIDGE_GUARD_ACTION_CHECK_STATUS,
          label: "Check status",
        },
      ],
      message: "Bridge is starting the local IPC socket Ambient uses for pairing and inference requests.",
      nextSteps: ["Keep Bridge open while the local socket starts.", "If this does not recover, quit and reopen Bridge."],
      rows: [accountRow("Signed in", "ready"), serverRow(status), ipcRow(status)],
      status: "checking",
      statusLabel: "Starting local access",
      title: "Starting Bridge access",
    });
  }

  if (status.serverReachability === "checking") {
    return blocked("network", {
      actions: [
        {
          busy: input.loading,
          id: BRIDGE_GUARD_ACTION_RETRY_REACHABILITY,
          label: "Check again",
        },
      ],
      message: "Bridge is checking whether the Ambient server is reachable before opening the app controls.",
      nextSteps: ["Keep your network connection active.", "If this stays here, try again or check VPN/firewall settings."],
      rows: [accountRow("Signed in", "ready"), serverRow(status), ipcRow(status)],
      status: "checking",
      statusLabel: "Checking network",
      title: "Checking server reachability",
    });
  }

  if (status.serverReachability === "unavailable") {
    return blocked("network", {
      actions: [
        {
          busy: input.loading,
          id: BRIDGE_GUARD_ACTION_RETRY_REACHABILITY,
          label: "Try again",
        },
      ],
      message: networkMessage(status),
      nextSteps: networkNextSteps(status.serverReachabilityReason),
      rows: [accountRow("Signed in", "ready"), serverRow(status), ipcRow(status)],
      status: "failed",
      statusLabel: networkStatusLabel(status.serverReachabilityReason),
      title: networkTitle(status.serverReachabilityReason),
    });
  }

  return { blocking: false, model: null, reason: null };
}

function blocked(
  reason: Exclude<BridgeSessionGuardState["reason"], null>,
  model: SessionGuardCardModel,
): BridgeSessionGuardState {
  return { blocking: true, model, reason };
}

function accountRow(value: string, status: SessionGuardStatus): SessionGuardRow {
  return {
    detail: "WorkOS session is stored by Bridge, not Ambient.",
    id: "account",
    label: "Account",
    status,
    value,
  };
}

function serverRow(status: BridgeStatus): SessionGuardRow {
  if (status.serverReachability === "reachable") {
    return {
      detail: "Bridge can reach the Ambient server health endpoint.",
      id: "server",
      label: "Server reachability",
      status: "ready",
      value: "Reachable",
    };
  }
  if (status.serverReachability === "checking") {
    return {
      detail: "Bridge is checking the Ambient server health endpoint.",
      id: "server",
      label: "Server reachability",
      status: "checking",
      value: "Checking",
    };
  }
  return {
    detail: status.serverReachabilityMessage,
    id: "server",
    label: "Server reachability",
    status: "failed",
    value: networkStatusLabel(status.serverReachabilityReason),
  };
}

function ipcRow(status: BridgeStatus): SessionGuardRow {
  return {
    detail: status.socketReady
      ? "Ambient is connected to Bridge."
      : "Preparing the connection to Ambient.",
    id: "ipc",
    label: "Connection to Ambient",
    status: status.socketReady ? "ready" : "checking",
    value: status.socketReady ? "Ready" : "Starting",
  };
}

function networkTitle(reason: BridgeServerReachabilityReason): string {
  if (reason === "offline") return "No internet route available";
  if (reason === "dns_failure") return "DNS lookup failed";
  if (reason === "server_error") return "Ambient server is unavailable";
  if (reason === "timeout") return "Server health check timed out";
  return "Bridge cannot reach Ambient server";
}

function networkNextSteps(reason: BridgeServerReachabilityReason): readonly string[] {
  if (reason === "offline") {
    return ["Check Wi-Fi or Ethernet, then try again.", "If you use a VPN or firewall, allow Ambient Bridge network egress."];
  }
  if (reason === "dns_failure") {
    return ["Check DNS or VPN settings.", "Try again after the server hostname resolves."];
  }
  if (reason === "server_error") {
    return ["Try again in a moment.", "If this persists, export diagnostics and include the server health status."];
  }
  if (reason === "timeout") {
    return ["Check for captive portals, VPN stalls, or firewall inspection.", "Try again after the network is stable."];
  }
  return ["Check your internet connection, VPN, or firewall.", "Try again when Bridge can reach the Ambient server."];
}
