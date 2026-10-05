/** Serializes startup before listener creation yields; cancellation invalidates late work. */
export class LoginStartGate {
  private generation = 0;
  private pending?: Promise<void>;
  private key?: string;
  run(start: (isCurrent: () => boolean) => Promise<void>, key = ""): Promise<void> {
    if (this.pending && this.key === key) return this.pending;
    if (this.pending) this.cancel();
    this.key = key;
    const generation = this.generation;
    const pending = Promise.resolve().then(() => start(() => generation === this.generation));
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
    return pending;
  }
  cancel(): void { this.generation++; this.pending = undefined; }
}
