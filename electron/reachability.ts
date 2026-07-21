export type ServerReachabilityState = "checking" | "reachable" | "unavailable";

export type ServerReachabilityReason =
  | "not_checked"
  | "ok"
  | "offline"
  | "dns_failure"
  | "timeout"
  | "server_error"
  | "network_error";

export type ServerReachabilitySnapshot = {
  readonly state: ServerReachabilityState;
  readonly reachable: boolean;
  readonly reason: ServerReachabilityReason;
  readonly message: string;
  readonly checkedAt: number | null;
  readonly httpStatus?: number | null;
};

export type ServerReachabilityProbeResult =
  | boolean
  | {
      readonly reachable: boolean;
      readonly reason?: ServerReachabilityReason;
      readonly message?: string;
      readonly httpStatus?: number | null;
    };

export type ServerReachabilityMonitorOptions = {
  clock?: () => number;
  onReachabilityChange?: (reachable: boolean, snapshot: ServerReachabilitySnapshot) => void;
  onStateChange?: (snapshot: ServerReachabilitySnapshot) => void;
  probe: () => Promise<ServerReachabilityProbeResult>;
  ttlMs: number;
};

const INITIAL_SNAPSHOT: ServerReachabilitySnapshot = {
  checkedAt: null,
  message: "Server reachability has not been checked yet.",
  reachable: false,
  reason: "not_checked",
  state: "checking",
};

export class ServerReachabilityMonitor {
  private readonly clock: () => number;
  private readonly onReachabilityChange?: (reachable: boolean, snapshot: ServerReachabilitySnapshot) => void;
  private readonly onStateChange?: (snapshot: ServerReachabilitySnapshot) => void;
  private readonly probe: () => Promise<ServerReachabilityProbeResult>;
  private readonly ttlMs: number;
  private inFlight?: Promise<ServerReachabilitySnapshot>;
  private snapshot: ServerReachabilitySnapshot = INITIAL_SNAPSHOT;

  constructor(options: ServerReachabilityMonitorOptions) {
    this.clock = options.clock ?? Date.now;
    this.onReachabilityChange = options.onReachabilityChange;
    this.onStateChange = options.onStateChange;
    this.probe = options.probe;
    this.ttlMs = options.ttlMs;
  }

  current(): ServerReachabilitySnapshot {
    const now = this.clock();
    if (this.inFlight) return this.snapshot;
    if (this.snapshot.checkedAt !== null && now - this.snapshot.checkedAt < this.ttlMs) {
      return this.snapshot;
    }

    void this.refresh();
    return this.snapshot;
  }

  async refresh(): Promise<ServerReachabilitySnapshot> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.probe()
      .then((result) => this.applyProbeResult(result))
      .catch(() => this.applyProbeResult({
        message: "Bridge could not complete the server reachability check.",
        reachable: false,
        reason: "network_error",
      }))
      .finally(() => {
        this.inFlight = undefined;
      });

    return this.inFlight;
  }

  private applyProbeResult(result: ServerReachabilityProbeResult): ServerReachabilitySnapshot {
    const previous = this.snapshot;
    const next = normalizeProbeResult(result, this.clock());
    this.snapshot = next;

    if (previous.checkedAt !== null && previous.reachable !== next.reachable) {
      this.onReachabilityChange?.(next.reachable, next);
    }
    if (!sameSnapshot(previous, next)) {
      this.onStateChange?.(next);
    }

    return next;
  }
}

function normalizeProbeResult(
  result: ServerReachabilityProbeResult,
  checkedAt: number,
): ServerReachabilitySnapshot {
  if (typeof result === "boolean") {
    return result
      ? {
          checkedAt,
          message: "Ambient server is reachable.",
          reachable: true,
          reason: "ok",
          state: "reachable",
        }
      : {
          checkedAt,
          message: "Ambient server is unreachable.",
          reachable: false,
          reason: "network_error",
          state: "unavailable",
        };
  }

  const reachable = result.reachable === true;
  const reason = reachable ? "ok" : result.reason ?? "network_error";
  return {
    checkedAt,
    httpStatus: result.httpStatus ?? null,
    message: result.message ?? (reachable ? "Ambient server is reachable." : "Ambient server is unreachable."),
    reachable,
    reason,
    state: reachable ? "reachable" : "unavailable",
  };
}

function sameSnapshot(a: ServerReachabilitySnapshot, b: ServerReachabilitySnapshot): boolean {
  return a.state === b.state
    && a.reachable === b.reachable
    && a.reason === b.reason
    && a.message === b.message
    && a.checkedAt === b.checkedAt
    && (a.httpStatus ?? null) === (b.httpStatus ?? null);
}
