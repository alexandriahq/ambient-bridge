import { describe, expect, it, vi } from "vitest";
import { ServerReachabilityMonitor } from "../electron/reachability.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ServerReachabilityMonitor", () => {
  it("shows checking before the first health result", async () => {
    const probeResult = deferred<boolean>();
    const probe = vi.fn(() => probeResult.promise);
    const monitor = new ServerReachabilityMonitor({
      probe,
      ttlMs: 8_000,
    });

    expect(monitor.current()).toMatchObject({ reason: "not_checked", state: "checking" });
    expect(monitor.current()).toMatchObject({ state: "checking" });
    expect(probe).toHaveBeenCalledTimes(1);

    probeResult.resolve(true);
    await flushPromises();

    expect(monitor.current()).toMatchObject({ reason: "ok", state: "reachable" });
  });

  it("keeps the last visible state through one transient probe failure", async () => {
    let now = 1_000;
    const probeResults: Deferred<boolean>[] = [];
    const probe = vi.fn(() => {
      const nextResult = deferred<boolean>();
      probeResults.push(nextResult);
      return nextResult.promise;
    });
    const onReachabilityChange = vi.fn();
    const onStateChange = vi.fn();
    const monitor = new ServerReachabilityMonitor({
      clock: () => now,
      onReachabilityChange,
      onStateChange,
      probe,
      ttlMs: 8_000,
    });

    expect(monitor.current()).toMatchObject({ state: "checking" });
    probeResults[0]?.resolve(true);
    await flushPromises();
    expect(monitor.current()).toMatchObject({ state: "reachable" });

    now += 8_001;
    expect(monitor.current()).toMatchObject({ state: "reachable" });
    expect(probe).toHaveBeenCalledTimes(2);

    probeResults[1]?.resolve(false);
    await flushPromises();

    expect(monitor.current()).toMatchObject({ reason: "ok", state: "reachable" });
    expect(onReachabilityChange).not.toHaveBeenCalled();

    now += 8_001;
    expect(monitor.current()).toMatchObject({ state: "reachable" });
    probeResults[2]?.resolve(false);
    await flushPromises();

    expect(monitor.current()).toMatchObject({ reason: "network_error", state: "unavailable" });
    expect(onReachabilityChange).toHaveBeenCalledWith(false, expect.objectContaining({ state: "unavailable" }));
    expect(onStateChange).toHaveBeenCalledTimes(3);
  });

  it("does not replace initial checking with a single timeout", async () => {
    const results = [
      { reachable: false, reason: "timeout" as const, message: "Server health check timed out." },
      { reachable: false, reason: "timeout" as const, message: "Server health check timed out." },
    ];
    const monitor = new ServerReachabilityMonitor({
      probe: async () => results.shift()!,
      ttlMs: 8_000,
    });

    await expect(monitor.refresh()).resolves.toMatchObject({ reason: "not_checked", state: "checking" });
    await expect(monitor.refresh()).resolves.toMatchObject({ reason: "timeout", state: "unavailable" });
  });

  it("exposes sanitized failure reasons from detailed probes", async () => {
    const monitor = new ServerReachabilityMonitor({
      clock: () => 1_700_000_000_000,
      probe: async () => ({
        httpStatus: 503,
        message: "Ambient server health check returned HTTP 503.",
        reachable: false,
        reason: "server_error",
      }),
      ttlMs: 8_000,
    });

    await expect(monitor.refresh()).resolves.toMatchObject({
      checkedAt: 1_700_000_000_000,
      httpStatus: 503,
      message: "Ambient server health check returned HTTP 503.",
      reason: "server_error",
      state: "unavailable",
    });
  });
});
