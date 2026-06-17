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

    expect(monitor.current()).toBe("checking");
    expect(monitor.current()).toBe("checking");
    expect(probe).toHaveBeenCalledTimes(1);

    probeResult.resolve(true);
    await flushPromises();

    expect(monitor.current()).toBe("reachable");
  });

  it("keeps the last visible state while a later stale check runs", async () => {
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

    expect(monitor.current()).toBe("checking");
    probeResults[0]?.resolve(true);
    await flushPromises();
    expect(monitor.current()).toBe("reachable");

    now += 8_001;
    expect(monitor.current()).toBe("reachable");
    expect(probe).toHaveBeenCalledTimes(2);

    probeResults[1]?.resolve(false);
    await flushPromises();

    expect(monitor.current()).toBe("unavailable");
    expect(onReachabilityChange).toHaveBeenCalledWith(false);
    expect(onStateChange).toHaveBeenCalledTimes(2);
  });
});
