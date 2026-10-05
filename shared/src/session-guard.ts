export type SessionGuardStatus = "checking" | "ready" | "needs_action" | "blocked" | "failed";

export type SessionGuardTone = "neutral" | "success" | "warning" | "danger";

export type SessionGuardAction = {
  readonly id: string;
  readonly label: string;
  readonly variant?: "primary" | "secondary";
  readonly disabled?: boolean;
  readonly busy?: boolean;
};

export type SessionGuardRow = {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly detail?: string | null;
  readonly status: SessionGuardStatus;
};

export type SessionGuardCardModel = {
  readonly eyebrow?: string;
  readonly title: string;
  readonly message: string;
  readonly detail?: string | null;
  readonly status: SessionGuardStatus;
  readonly statusLabel: string;
  readonly rows?: readonly SessionGuardRow[];
  readonly actions?: readonly SessionGuardAction[];
  readonly nextSteps?: readonly string[];
};

export function sessionGuardTone(status: SessionGuardStatus): SessionGuardTone {
  if (status === "ready") return "success";
  if (status === "failed") return "danger";
  if (status === "needs_action" || status === "blocked") return "warning";
  return "neutral";
}

export function networkStatusLabel(reason: string | null | undefined): string {
  if (reason === "offline") return "Offline";
  if (reason === "dns_failure") return "DNS failed";
  if (reason === "server_error") return "Server down";
  if (reason === "timeout") return "Timed out";
  if (reason === "not_checked") return "Not checked";
  return "Unreachable";
}

export function networkMessage(status: {
  readonly serverReachabilityMessage?: string | null;
  readonly serverReachabilityReason?: string | null;
}): string {
  const detail = status.serverReachabilityMessage?.trim();
  if (detail) return detail;
  if (status.serverReachabilityReason === "offline") return "Bridge could not find an internet route to the Ambient server.";
  if (status.serverReachabilityReason === "dns_failure") return "Bridge could not resolve the Ambient server hostname.";
  if (status.serverReachabilityReason === "server_error") return "The Ambient server health check did not return a healthy response.";
  if (status.serverReachabilityReason === "timeout") return "The Ambient server health check took too long to respond.";
  return "Bridge could not reach the Ambient server.";
}
