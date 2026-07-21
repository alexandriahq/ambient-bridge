export type BridgeBeforeQuitEvent = {
  preventDefault(): void;
};

export type BridgeShutdownCoordinatorOptions = {
  readonly beforeShutdown?: () => void;
  readonly abortActiveInference: () => void;
  readonly stopIpcServer: () => Promise<void>;
  readonly stopIpcServerTimeoutMs?: number;
  readonly flushAudit?: () => Promise<void>;
  readonly flushAuditTimeoutMs?: number;
  readonly exit: (exitCode: number) => void;
  readonly onFailure?: (error: unknown) => void | Promise<void>;
  readonly onFailureTimeoutMs?: number;
};

export type BridgeShutdownCoordinator = {
  /** Electron `before-quit` adapter. Prevents the first quit until cleanup settles. */
  handleBeforeQuit(event: BridgeBeforeQuitEvent): void;
  /** Idempotent cleanup entry point for tests and non-Electron shutdown triggers. */
  shutdown(): Promise<void>;
};

export type BridgeShutdownPhase = "ipc_stop" | "audit_flush" | "failure_handler";

export class BridgeShutdownTimeoutError extends Error {
  readonly _tag = "BridgeShutdownTimeoutError";

  constructor(
    readonly phase: BridgeShutdownPhase,
    readonly timeoutMs: number,
  ) {
    super(`Bridge shutdown phase ${phase} timed out after ${timeoutMs} ms.`);
    this.name = "BridgeShutdownTimeoutError";
  }
}

const DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS = 2_000;

/**
 * Coordinates the asynchronous work Electron does not await from event listeners.
 * Every quit request joins one cleanup promise; once it settles, `app.exit` performs
 * the terminal exit without re-entering the graceful-quit path.
 */
export function createBridgeShutdownCoordinator(
  options: BridgeShutdownCoordinatorOptions,
): BridgeShutdownCoordinator {
  let shutdownPromise: Promise<void> | undefined;
  let exitRequested = false;

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= Promise.resolve().then(async () => {
      options.beforeShutdown?.();
      options.abortActiveInference();
      let stopError: unknown;
      try {
        await completesWithin(
          options.stopIpcServer(),
          options.stopIpcServerTimeoutMs ?? DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
          "ipc_stop",
        );
      } catch (error) {
        stopError = error;
      }
      let flushError: unknown;
      try {
        if (options.flushAudit) {
          await completesWithin(
            options.flushAudit(),
            options.flushAuditTimeoutMs ?? DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
            "audit_flush",
          );
        }
      } catch (error) {
        flushError = error;
      }
      if (stopError !== undefined) throw stopError;
      if (flushError !== undefined) throw flushError;
    });
    return shutdownPromise;
  };

  return {
    handleBeforeQuit: (event) => {
      if (exitRequested) return;
      event.preventDefault();
      void shutdown().then(
        () => {
          if (exitRequested) return;
          exitRequested = true;
          options.exit(0);
        },
        async (error) => {
          if (exitRequested) return;
          exitRequested = true;
          try {
            if (options.onFailure) {
              await completesWithin(
                Promise.resolve().then(() => options.onFailure?.(error)),
                options.onFailureTimeoutMs ?? DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
                "failure_handler",
              );
            }
          } catch {
            // Failure reporting is best-effort; shutdown must remain terminal.
          }
          try {
            if (options.flushAudit) {
              // `onFailure` may have added the terminal failure event after the
              // normal flush. Give it one bounded durability attempt, then exit.
              await completesWithin(
                options.flushAudit(),
                options.flushAuditTimeoutMs ?? DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
                "audit_flush",
              );
            }
          } catch {
            // A wedged audit sink must never keep Electron alive indefinitely.
          } finally {
            options.exit(1);
          }
        },
      );
    },
    shutdown,
  };
}

async function completesWithin(
  work: Promise<void>,
  timeoutMs: number,
  phase: BridgeShutdownPhase,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new BridgeShutdownTimeoutError(phase, timeoutMs)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
