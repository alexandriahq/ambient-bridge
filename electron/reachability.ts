export type ServerReachabilityState = "checking" | "reachable" | "unavailable";

export type ServerReachabilityMonitorOptions = {
  clock?: () => number;
  onReachabilityChange?: (reachable: boolean) => void;
  onStateChange?: () => void;
  probe: () => Promise<boolean>;
  ttlMs: number;
};

export class ServerReachabilityMonitor {
  private readonly clock: () => number;
  private readonly onReachabilityChange?: (reachable: boolean) => void;
  private readonly onStateChange?: () => void;
  private readonly probe: () => Promise<boolean>;
  private readonly ttlMs: number;
  private checkedAt = 0;
  private inFlight?: Promise<boolean>;
  private reachable = false;
  private state: ServerReachabilityState = "checking";

  constructor(options: ServerReachabilityMonitorOptions) {
    this.clock = options.clock ?? Date.now;
    this.onReachabilityChange = options.onReachabilityChange;
    this.onStateChange = options.onStateChange;
    this.probe = options.probe;
    this.ttlMs = options.ttlMs;
  }

  current(): ServerReachabilityState {
    const now = this.clock();
    if (this.inFlight) return this.state;
    if (this.checkedAt > 0 && now - this.checkedAt < this.ttlMs) {
      return this.state;
    }

    if (this.checkedAt === 0) {
      this.state = "checking";
    }
    this.inFlight = this.probe()
      .then((reachable) => {
        const nextState: ServerReachabilityState = reachable ? "reachable" : "unavailable";
        const previousReachable = this.reachable;
        const changed = this.state !== nextState || this.reachable !== reachable;
        const hadPreviousCheck = this.checkedAt > 0;

        this.checkedAt = this.clock();
        this.reachable = reachable;
        this.state = nextState;

        if (hadPreviousCheck && previousReachable !== reachable) {
          this.onReachabilityChange?.(reachable);
        }
        if (changed) {
          this.onStateChange?.();
        }
        return reachable;
      })
      .finally(() => {
        this.inFlight = undefined;
      });

    return this.state;
  }
}
