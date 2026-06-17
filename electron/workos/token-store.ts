import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkOsSession } from "./session.js";

export type TokenCrypto = {
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  isEncryptionAvailable(): boolean;
};

export class EncryptedSessionStore {
  private cached: WorkOsSession | undefined;
  private readPromise: Promise<WorkOsSession> | undefined;
  private revision = 0;

  constructor(
    private readonly path: string,
    private readonly crypto: TokenCrypto,
  ) {}

  async read(): Promise<WorkOsSession> {
    if (this.cached) {
      return this.cached;
    }
    this.readPromise ??= this.readFromDisk(this.revision).finally(() => {
      this.readPromise = undefined;
    });
    return this.readPromise;
  }

  private async readFromDisk(revision: number): Promise<WorkOsSession> {
    let session: WorkOsSession;
    try {
      const encrypted = await readFile(this.path);
      const decrypted = this.crypto.decryptString(encrypted);
      session = JSON.parse(decrypted) as WorkOsSession;
    } catch {
      session = { kind: "signed_out" };
    }
    if (this.revision === revision) {
      this.cached = session;
    }
    return this.cached ?? session;
  }

  async write(session: WorkOsSession): Promise<void> {
    if (!this.crypto.isEncryptionAvailable()) {
      throw new Error("OS-backed encryption is unavailable");
    }

    await mkdir(dirname(this.path), { recursive: true });
    const encrypted = this.crypto.encryptString(JSON.stringify(session));
    await writeFile(this.path, encrypted, { mode: 0o600 });
    this.revision += 1;
    this.cached = session;
  }

  async clear(): Promise<void> {
    this.revision += 1;
    this.cached = { kind: "signed_out" };
    this.readPromise = undefined;
    await rm(this.path, { force: true });
  }
}
