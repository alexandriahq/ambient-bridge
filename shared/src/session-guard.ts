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
