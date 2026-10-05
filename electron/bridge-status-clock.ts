import { randomUUID } from "node:crypto";

/** One process identity; revisions advance when the public snapshot changes. */
export class BridgeStatusClock {
  readonly bridgeInstanceId = randomUUID();
  #signature: string | undefined;
  #revision = 0;

  observe(signature: string): { bridgeInstanceId: string; revision: number } {
    if (signature !== this.#signature) {
      this.#signature = signature;
      this.#revision += 1;
    }
    return { bridgeInstanceId: this.bridgeInstanceId, revision: this.#revision };
  }
}
