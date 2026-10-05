import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SignedInWorkOsSession, WorkOsSession } from "./session.js";

export type TokenCrypto = {
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  isEncryptionAvailable(): boolean;
};

export type SessionStoreWriteResult = "session_changed" | "signed_out" | "written";

export class EncryptedSessionStore {
  private cached: WorkOsSession | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
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

  /** In-memory session only — null until the first successful read/write. */
  peekCached(): WorkOsSession | null {
    return this.cached ?? null;
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
    await this.mutate(async () => this.writeUnlocked(session));
  }

  async clear(): Promise<void> {
    await this.mutate(async () => this.clearUnlocked());
  }

  async writeIfOwned(session: WorkOsSession, ownsLogin: () => boolean): Promise<boolean> {
    return this.mutate(async () => {
      // Check inside the queue: logout may cancel a callback while it waits.
      if (!ownsLogin()) return false;
      const previous = await this.read();
      if (!ownsLogin()) return false;
      await this.writeUnlocked(session);
      if (!ownsLogin()) {
        // Replacement can arrive during the filesystem write. Restore the prior
        // session inside the mutation queue before another login can commit.
        if (previous.kind === "signed_out") await this.clearUnlocked();
        else await this.writeUnlocked(previous);
        return false;
      }
      return true;
    });
  }

  async clearIfCurrent(expectedSession: SignedInWorkOsSession): Promise<boolean> {
    return await this.mutate(async () => {
      const current = await this.read();
      if (
        current.kind !== "signed_in"
        || current.user.id !== expectedSession.user.id
        || current.sessionToken !== expectedSession.sessionToken
      ) {
        return false;
      }

      await this.clearUnlocked();
      return true;
    });
  }

  async writeIfCurrent(
    nextSession: SignedInWorkOsSession,
    expectedSession: SignedInWorkOsSession,
    ownsCurrent?: (session: SignedInWorkOsSession) => boolean,
  ): Promise<SessionStoreWriteResult> {
    return await this.mutate(async () => {
      const current = await this.read();
      if (current.kind !== "signed_in") return "signed_out";
      if (
        current.user.id !== expectedSession.user.id
        || current.sessionToken !== expectedSession.sessionToken
        || ownsCurrent?.(current) === false
      ) {
        return "session_changed";
      }

      await this.writeUnlocked(nextSession);
      return "written";
    });
  }

  private async writeUnlocked(session: WorkOsSession): Promise<void> {
    if (!this.crypto.isEncryptionAvailable()) {
      throw new Error("OS-backed encryption is unavailable");
    }

    await mkdir(dirname(this.path), { recursive: true });
    const encrypted = this.crypto.encryptString(JSON.stringify(session));
    // Keep the last complete session until its replacement is fully written.
    // A sibling file keeps rename on the same filesystem, including Windows.
    const temporaryPath = `${this.path}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, encrypted, { mode: 0o600, flag: "wx", flush: true });
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    this.revision += 1;
    this.cached = session;
  }

  private async clearUnlocked(): Promise<void> {
    const previous = this.cached;
    this.revision += 1;
    this.cached = { kind: "signed_out" };
    this.readPromise = undefined;
    try {
      await rm(this.path, { force: true });
    } catch (error) {
      // Suppress stale refresh publication while clearing, but do not leave a
      // successful-looking cache when credentials remain on disk. Allow retry.
      this.revision += 1;
      this.cached = previous;
      this.readPromise = undefined;
      throw error;
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
