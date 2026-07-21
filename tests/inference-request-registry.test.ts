import { describe, expect, it } from "vitest";
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
