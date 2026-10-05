import { describe, expect, it, vi } from "vitest";
import { InferenceRequestRegistry } from "../electron/inference/request-registry.js";

describe("InferenceRequestRegistry", () => {
  it("isolates the same request id by authenticated client", () => {
    const registry = new InferenceRequestRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.register({ controller: first, credentialId: "client-a", requestId: "same" });
    registry.register({ controller: second, credentialId: "client-b", requestId: "same" });

    expect(registry.cancel("client-a", "same")).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(registry.size).toBe(1);
  });

  it("aborts and releases a request when its socket closes", async () => {
    const registry = new InferenceRequestRegistry();
    const controller = new AbortController();
    let close!: () => void;
    const socketClosed = new Promise<void>((resolve) => { close = resolve; });
    registry.register({ controller, credentialId: "client", requestId: "request", socketClosed });

    close();
    await socketClosed;
    await Promise.resolve();

    expect(controller.signal.aborted).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("does not release a replacement when an older request finishes", () => {
    const registry = new InferenceRequestRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.register({ controller: first, credentialId: "client", requestId: "request" });
    registry.register({ controller: second, credentialId: "client", requestId: "request" });

    registry.release("client", "request", first);

    expect(first.signal.aborted).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.cancel("client", "request")).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it("aborts every request during shutdown", () => {
    const registry = new InferenceRequestRegistry();
    const controllers = [new AbortController(), new AbortController()];
    controllers.forEach((controller, index) => registry.register({
      controller,
      credentialId: `client-${index}`,
      requestId: "request",
    }));

    registry.abortAll();

    expect(controllers.every(({ signal }) => signal.aborted)).toBe(true);
    expect(registry.size).toBe(0);
  });
});

function socketLifetime() {
  let close!: () => void;
  const closed = new Promise<void>(resolve => { close = resolve; });
  const subscriptions = vi.spyOn(closed, "then");
  return { closed, close, subscriptions };
}

it("retains one close subscription across completed requests and idle connection reuse", async () => {
  const registry = new InferenceRequestRegistry();
  const socket = socketLifetime();
  for (let index = 0; index < 2_000; index++) {
    const controller = new AbortController();
    registry.register({ controller, credentialId: "client", requestId: String(index), socketClosed: socket.closed });
    registry.release("client", String(index), controller);
  }
  expect(registry.size).toBe(0);
  const active = new AbortController();
  registry.register({ controller: active, credentialId: "client", requestId: "active", socketClosed: socket.closed });
  expect(socket.subscriptions).toHaveBeenCalledTimes(1);
  socket.close();
  await socket.closed;
  expect(active.signal.reason).toBe("connection_closed");
  expect(registry.size).toBe(0);
});

it("cancelling removes ownership before abort listeners can replace it", () => {
  const registry = new InferenceRequestRegistry();
  const original = new AbortController();
  const replacement = new AbortController();
  registry.register({ controller: original, credentialId: "client", requestId: "same" });
  original.signal.addEventListener("abort", () => {
    registry.register({ controller: replacement, credentialId: "client", requestId: "same" });
  }, { once: true });
  expect(registry.cancel("client", "same")).toBe(true);
  expect(registry.size).toBe(1);
  expect(replacement.signal.aborted).toBe(false);
  expect(registry.cancel("client", "same")).toBe(true);
  expect(replacement.signal.reason).toBe("client_cancelled");
});

it("an old socket cannot cancel a replacement on another socket", async () => {
  const registry = new InferenceRequestRegistry();
  const oldSocket = socketLifetime(), newSocket = socketLifetime();
  const old = new AbortController(), current = new AbortController();
  registry.register({ controller: old, credentialId: "client", requestId: "same", socketClosed: oldSocket.closed });
  registry.register({ controller: current, credentialId: "client", requestId: "same", socketClosed: newSocket.closed });
  oldSocket.close();
  await oldSocket.closed;
  expect(old.signal.reason).toBe("replaced");
  expect(current.signal.aborted).toBe(false);
  expect(registry.size).toBe(1);
  newSocket.close();
  await newSocket.closed;
  expect(current.signal.reason).toBe("connection_closed");
  expect(registry.size).toBe(0);
});

it("cancels late registrations on an already closed group without another subscription", async () => {
  const registry = new InferenceRequestRegistry();
  const socket = socketLifetime();
  const original = new AbortController();
  registry.register({ controller: original, credentialId: "client", requestId: "old", socketClosed: socket.closed });
  registry.release("client", "old", original);
  socket.close();
  await socket.closed;
  const late = new AbortController();
  registry.register({ controller: late, credentialId: "client", requestId: "late", socketClosed: socket.closed });
  expect(late.signal.aborted).toBe(false);
  await Promise.resolve();
  expect(late.signal.reason).toBe("connection_closed");
  expect(original.signal.aborted).toBe(false);
  expect(registry.size).toBe(0);
  expect(socket.subscriptions).toHaveBeenCalledTimes(1);
});

it("release, cancellation and shutdown remove entries from the reusable socket group", async () => {
  const registry = new InferenceRequestRegistry();
  const socket = socketLifetime();
  const released = new AbortController(), cancelled = new AbortController(), stopped = new AbortController();
  for (const [requestId, controller] of [["released", released], ["cancelled", cancelled], ["stopped", stopped]] as const) {
    registry.register({ controller, credentialId: "client", requestId, socketClosed: socket.closed });
  }
  registry.release("client", "released", released);
  registry.cancel("client", "cancelled");
  registry.abortAll();
  const current = new AbortController();
  registry.register({ controller: current, credentialId: "client", requestId: "stopped", socketClosed: socket.closed });
  socket.close();
  await socket.closed;
  expect(released.signal.aborted).toBe(false);
  expect(cancelled.signal.reason).toBe("client_cancelled");
  expect(stopped.signal.reason).toBe("bridge_shutdown");
  expect(current.signal.reason).toBe("connection_closed");
  expect(registry.size).toBe(0);
  expect(socket.subscriptions).toHaveBeenCalledTimes(1);
});
