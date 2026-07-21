import { describe, expect, it, vi } from "vitest";
import {
  BridgeShutdownTimeoutError,
  createBridgeShutdownCoordinator,
} from "../electron/shutdown-coordinator.js";

describe("Bridge shutdown coordinator", () => {
  it("coalesces quit requests and exits only after inference and IPC cleanup", async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const beforeShutdown = vi.fn();
    const abortActiveInference = vi.fn();
    const stopIpcServer = vi.fn(() => stopGate);
    const flushAudit = vi.fn(async () => undefined);
    const exit = vi.fn();
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };
    const coordinator = createBridgeShutdownCoordinator({
      abortActiveInference,
      beforeShutdown,
      exit,
      flushAudit,
      stopIpcServer,
    });

    coordinator.handleBeforeQuit(firstEvent);
    coordinator.handleBeforeQuit(secondEvent);
    await Promise.resolve();

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(beforeShutdown).toHaveBeenCalledOnce();
    expect(abortActiveInference).toHaveBeenCalledOnce();
    expect(stopIpcServer).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();

    releaseStop();
    await coordinator.shutdown();
    await Promise.resolve();

    expect(flushAudit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);

    const terminalEvent = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(terminalEvent);
    expect(terminalEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("reports cleanup failure and exits once with a failure status", async () => {
    const failure = new Error("IPC stop failed");
    const exit = vi.fn();
    let releaseFailureAudit!: () => void;
    const failureAuditGate = new Promise<void>((resolve) => { releaseFailureAudit = resolve; });
    const onFailure = vi.fn(() => failureAuditGate);
    const flushAudit = vi.fn(async () => undefined);
    const event = { preventDefault: vi.fn() };
    const coordinator = createBridgeShutdownCoordinator({
      abortActiveInference: vi.fn(),
      exit,
      flushAudit,
      onFailure,
      stopIpcServer: vi.fn(async () => {
        throw failure;
      }),
    });

    coordinator.handleBeforeQuit(event);
    await expect(coordinator.shutdown()).rejects.toBe(failure);
    await Promise.resolve();

    expect(flushAudit).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(failure);
    expect(exit).not.toHaveBeenCalled();
    releaseFailureAudit();
    await failureAuditGate;
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    expect(flushAudit).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("bounds IPC stop and failure reporting before forcing a terminal exit", async () => {
    const never = () => new Promise<void>(() => undefined);
    const stopIpcServer = vi.fn(never);
    const flushAudit = vi.fn(never);
    const onFailure = vi.fn(never);
    let resolveExit!: (exitCode: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const exit = vi.fn(resolveExit);
    const coordinator = createBridgeShutdownCoordinator({
      abortActiveInference: vi.fn(),
      exit,
      flushAudit,
      flushAuditTimeoutMs: 5,
      onFailure,
      onFailureTimeoutMs: 5,
      stopIpcServer,
      stopIpcServerTimeoutMs: 5,
    });
    const shutdown = coordinator.shutdown();

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });

    await expect(shutdown).rejects.toMatchObject({
      _tag: "BridgeShutdownTimeoutError",
      phase: "ipc_stop",
      timeoutMs: 5,
    } satisfies Partial<BridgeShutdownTimeoutError>);
    await expect(Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Bridge did not exit after bounded shutdown failure handling.")), 250);
      }),
    ])).resolves.toBe(1);

    expect(stopIpcServer).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(flushAudit).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledOnce();
  });
});
