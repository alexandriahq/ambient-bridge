// Functional status indicators for Bridge health (connection, IPC, server,
// pairing, attestation). These are genuine traffic-light signals, not domain
// enum labels, so a small green/amber/red set is intentional. Callers pair the
// returned color classes with the base `size-2 rounded-full ring-[3px]`.

const GOOD = "bg-success ring-success/20";
const PENDING = "bg-warning ring-warning/20";
const BAD = "bg-danger ring-danger/20";
const IDLE = "bg-ink-faint ring-ink-faint/15";

export function statusDotClass(state: string | null | undefined): string {
  switch (state) {
    case "ready":
    case "reachable":
    case "signed_in":
    case "verified":
    case "completed":
    case "active":
      return GOOD;
    case "starting":
    case "checking":
    case "retrying":
    case "degraded":
    case "login_pending":
    case "proxy_unavailable":
    case "attestation_invalid":
    case "not_checked":
    case "verifying":
    case "pending":
      return PENDING;
    case "offline":
    case "unavailable":
    case "signed_out":
    case "failed":
    case "cancelled":
      return BAD;
    default:
      return IDLE;
  }
}
