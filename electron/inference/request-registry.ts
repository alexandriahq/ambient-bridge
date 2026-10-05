export type InferenceRequestRegistration = {
  readonly controller: AbortController;
  readonly credentialId: string;
  readonly requestId: string;
  readonly socketClosed?: Promise<void>;
};

type ActiveRequest = {
  readonly key: string;
  readonly controller: AbortController;
  readonly socket?: SocketRequests;
};

type SocketRequests = {
  readonly requests: Set<ActiveRequest>;
  closed: boolean;
};

/** Owns active inference and one close subscription per authenticated socket. */
export class InferenceRequestRegistry {
  private readonly requests = new Map<string, ActiveRequest>();
  private readonly sockets = new WeakMap<Promise<void>, SocketRequests>();

  get size(): number {
    return this.requests.size;
  }

  register(registration: InferenceRequestRegistration): void {
    const key = inferenceRequestKey(registration.credentialId, registration.requestId);
    const previous = this.requests.get(key);
    if (previous) this.remove(previous);
    const socket = registration.socketClosed ? this.socketRequests(registration.socketClosed) : undefined;
    const active = { key, controller: registration.controller, socket };
    this.requests.set(key, active);
    socket?.requests.add(active);
    if (previous && previous.controller !== active.controller) previous.controller.abort("replaced");
    // A resolved close promise previously installed a fresh microtask per
    // registration. Preserve cancellation for late callers without resubscribing.
    if (socket?.closed) queueMicrotask(() => this.abort(active, "connection_closed"));
  }

  cancel(credentialId: string, requestId: string): boolean {
    const active = this.requests.get(inferenceRequestKey(credentialId, requestId));
    if (!active) return false;
    this.abort(active, "client_cancelled");
    return true;
  }

  release(credentialId: string, requestId: string, controller: AbortController): void {
    const active = this.requests.get(inferenceRequestKey(credentialId, requestId));
    if (active?.controller === controller) this.remove(active);
  }

  abortAll(reason = "bridge_shutdown"): void {
    for (const request of [...this.requests.values()]) this.abort(request, reason);
  }

  private socketRequests(closed: Promise<void>): SocketRequests {
    let socket = this.sockets.get(closed);
    if (socket) return socket;
    socket = { requests: new Set(), closed: false };
    this.sockets.set(closed, socket);
    const group = socket;
    // Keep this group through idle periods. Completed requests are removed,
    // so a long-lived connection retains no per-request close callbacks.
    void closed.then(() => {
      group.closed = true;
      for (const request of [...group.requests]) this.abort(request, "connection_closed");
    });
    return socket;
  }

  private remove(active: ActiveRequest): void {
    if (this.requests.get(active.key) === active) this.requests.delete(active.key);
    active.socket?.requests.delete(active);
  }

  private abort(active: ActiveRequest, reason: string): void {
    if (this.requests.get(active.key) !== active) return;
    // Abort listeners run synchronously and may register the same key again.
    this.remove(active);
    active.controller.abort(reason);
  }
}

export function inferenceRequestKey(credentialId: string, requestId: string): string {
  return `${credentialId.length}:${credentialId}${requestId}`;
}
