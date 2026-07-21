import { AuthServerRequestError } from "./auth/server-client.js";

export type SessionRefreshState = "ready" | "refreshing" | "retrying" | "degraded";

export type SessionRefreshSnapshot = {
  readonly state: SessionRefreshState;
  readonly attempt: number;
  readonly message: string | null;
  readonly nextRetryAt: number | null;
};

export type SessionRefreshRetryPolicy = {
  readonly baseDelayMs: number;
  readonly maxAttempts: number;
  readonly maxDelayMs: number;
  readonly recoveryDelayMs: number;
};

export type SessionRefreshRetryEvent = {
  readonly attempt: number;
  readonly delayMs: number | null;
  readonly message: string;
  readonly reason: string;
};

export type SessionRefreshCoordinatorOptions<Session> = {
  readonly errorMessage: (error: unknown) => string;
  readonly now?: () => number;
  readonly onRetryExhausted?: (event: SessionRefreshRetryEvent) => void;
  readonly onRetryScheduled?: (event: SessionRefreshRetryEvent) => void;
  readonly onStateChange?: (snapshot: SessionRefreshSnapshot) => void;
  readonly policy: SessionRefreshRetryPolicy;
  readonly readSession: () => Promise<Session | null>;
  readonly refreshSession: (session: Session) => Promise<void>;
  readonly sleep?: (delayMs: number) => Promise<void>;
};

export type SessionRefreshFailureDisposition = "retry" | "signed_out" | "stale";

export function isDefinitiveSessionRejection(error: unknown): boolean {
  return error instanceof AuthServerRequestError && error.status === 401;
}

export function isAuthProviderUnavailableError(error: unknown): boolean {
  return error instanceof AuthServerRequestError && error.status === 503;
}

export async function resolveSessionRefreshFailure(
  error: unknown,
  options: {
    readonly clearSession: (error: unknown) => Promise<boolean>;
    readonly isDefinitiveRejection: (error: unknown) => boolean;
  },
): Promise<SessionRefreshFailureDisposition> {
  if (!options.isDefinitiveRejection(error)) return "retry";
  return await options.clearSession(error) ? "signed_out" : "stale";
}

export const READY_SESSION_REFRESH_SNAPSHOT: SessionRefreshSnapshot = {
  attempt: 0,
  message: null,
  nextRetryAt: null,
  state: "ready",
};

export function sessionRefreshConnectionState(
  snapshot: SessionRefreshSnapshot,
): "ready" | "retrying" | "degraded" {
  if (snapshot.state === "degraded") return "degraded";
  if (snapshot.state === "refreshing" || snapshot.state === "retrying") return "retrying";
  return "ready";
}

export function sessionRefreshDelayMs(
  attempt: number,
  policy: Pick<SessionRefreshRetryPolicy, "baseDelayMs" | "maxDelayMs">,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(policy.baseDelayMs * 2 ** (safeAttempt - 1), policy.maxDelayMs);
}

export class SessionRefreshCoordinator<Session> {
  readonly #options: SessionRefreshCoordinatorOptions<Session>;
  #activeRefresh: Promise<void> | null = null;
  #disposed = false;
  #generation = 0;
  #recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  #snapshot = READY_SESSION_REFRESH_SNAPSHOT;

  constructor(options: SessionRefreshCoordinatorOptions<Session>) {
    this.#options = options;
  }

  snapshot(): SessionRefreshSnapshot {
    return { ...this.#snapshot };
  }

  markReady(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#activeRefresh = null;
    this.#clearRecoveryTimer();
    this.#setSnapshot(READY_SESSION_REFRESH_SNAPSHOT);
  }

  noteTransientFailure(error: unknown, reason: string): void {
    if (this.#disposed || this.#activeRefresh || this.#recoveryTimer) return;

    const generation = ++this.#generation;
    const attempt = Math.max(1, this.#snapshot.attempt);
    const delayMs = this.#options.policy.baseDelayMs;
    const message = this.#options.errorMessage(error);
    const nextRetryAt = (this.#options.now ?? Date.now)() + delayMs;
    this.#setSnapshot({ attempt, message, nextRetryAt, state: "retrying" });
    if (!this.#isCurrent(generation)) return;
    this.#options.onRetryScheduled?.({ attempt, delayMs, message, reason });
    this.#scheduleRecovery(reason, delayMs, generation);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#activeRefresh = null;
    this.#clearRecoveryTimer();
  }

  refresh(reason: string): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#activeRefresh) return this.#activeRefresh;
    this.#clearRecoveryTimer();
    const generation = ++this.#generation;
    const activeRefresh = this.#runRetryCycle(reason, generation).finally(() => {
      if (this.#activeRefresh === activeRefresh) this.#activeRefresh = null;
    });
    this.#activeRefresh = activeRefresh;
    return activeRefresh;
  }

  async #runRetryCycle(reason: string, generation: number): Promise<void> {
    for (let attempt = 1; attempt <= this.#options.policy.maxAttempts; attempt += 1) {
      const session = await this.#options.readSession();
      if (!this.#isCurrent(generation)) return;
      if (!session) {
        this.#setSnapshot(READY_SESSION_REFRESH_SNAPSHOT);
        return;
      }

      this.#setSnapshot({ attempt, message: null, nextRetryAt: null, state: "refreshing" });
      if (!this.#isCurrent(generation)) return;
      try {
        await this.#options.refreshSession(session);
        if (!this.#isCurrent(generation)) return;
        this.#setSnapshot(READY_SESSION_REFRESH_SNAPSHOT);
        return;
      } catch (error) {
        if (!this.#isCurrent(generation)) return;
        const message = this.#options.errorMessage(error);
        if (attempt >= this.#options.policy.maxAttempts) {
          const delayMs = this.#options.policy.recoveryDelayMs;
          const nextRetryAt = (this.#options.now ?? Date.now)() + delayMs;
          this.#setSnapshot({ attempt, message, nextRetryAt, state: "degraded" });
          if (!this.#isCurrent(generation)) return;
          this.#options.onRetryExhausted?.({ attempt, delayMs, message, reason });
          this.#scheduleRecovery(reason, delayMs, generation);
          return;
        }

        const delayMs = sessionRefreshDelayMs(attempt, this.#options.policy);
        const nextRetryAt = (this.#options.now ?? Date.now)() + delayMs;
        this.#setSnapshot({ attempt, message, nextRetryAt, state: "retrying" });
        if (!this.#isCurrent(generation)) return;
        this.#options.onRetryScheduled?.({ attempt, delayMs, message, reason });
        await (this.#options.sleep ?? defaultSleep)(delayMs);
        if (!this.#isCurrent(generation)) return;
      }
    }
  }

  #isCurrent(generation: number): boolean {
    return !this.#disposed && this.#generation === generation;
  }

  #setSnapshot(snapshot: SessionRefreshSnapshot): void {
    if (sameSnapshot(this.#snapshot, snapshot)) return;
    this.#snapshot = snapshot;
    this.#options.onStateChange?.(this.snapshot());
  }

  #scheduleRecovery(reason: string, delayMs: number, generation: number): void {
    if (!this.#isCurrent(generation)) return;
    this.#clearRecoveryTimer();
    this.#recoveryTimer = setTimeout(() => {
      this.#recoveryTimer = null;
      if (!this.#isCurrent(generation)) return;
      void this.refresh(`session_recovery:${reason}`);
    }, delayMs);
    this.#recoveryTimer.unref?.();
  }

  #clearRecoveryTimer(): void {
    if (!this.#recoveryTimer) return;
    clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = null;
  }
}

function sameSnapshot(a: SessionRefreshSnapshot, b: SessionRefreshSnapshot): boolean {
  return a.state === b.state
    && a.attempt === b.attempt
    && a.message === b.message
    && a.nextRetryAt === b.nextRetryAt;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}
