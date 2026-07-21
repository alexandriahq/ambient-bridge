export type InferenceRequestRegistration = {
  readonly controller: AbortController;
  readonly credentialId: string;
  readonly requestId: string;
  readonly socketClosed?: Promise<void>;
};

type ActiveRequest = Pick<InferenceRequestRegistration, "controller" | "credentialId" | "requestId">;

/** Owns in-flight inference cancellation by authenticated client. */
export class InferenceRequestRegistry {
  private readonly requests = new Map<string, ActiveRequest>();

  get size(): number {
    return this.requests.size;
  }

  register(registration: InferenceRequestRegistration): void {
    const key = inferenceRequestKey(registration.credentialId, registration.requestId);
    const previous = this.requests.get(key);
    if (previous && previous.controller !== registration.controller) {
      previous.controller.abort("replaced");
    }
    this.requests.set(key, registration);

    void registration.socketClosed?.then(() => {
      const active = this.requests.get(key);
      if (active?.controller !== registration.controller) return;
      active.controller.abort("connection_closed");
      this.requests.delete(key);
    });
  }

  cancel(credentialId: string, requestId: string): boolean {
    const key = inferenceRequestKey(credentialId, requestId);
    const active = this.requests.get(key);
    if (!active) return false;
    active.controller.abort("client_cancelled");
    this.requests.delete(key);
    return true;
  }

  release(credentialId: string, requestId: string, controller: AbortController): void {
    const key = inferenceRequestKey(credentialId, requestId);
    if (this.requests.get(key)?.controller === controller) {
      this.requests.delete(key);
    }
  }

  abortAll(reason = "bridge_shutdown"): void {
    for (const request of this.requests.values()) request.controller.abort(reason);
    this.requests.clear();
  }
}

export function inferenceRequestKey(credentialId: string, requestId: string): string {
  return `${credentialId.length}:${credentialId}${requestId}`;
}
