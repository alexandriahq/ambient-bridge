export interface CrashRingEntryInput {
  readonly atMs: number;
  readonly level: string;
  readonly component: string;
  /** Short human-readable message, pre-truncated by the caller. */
  readonly message: string;
  /** Full serialized JSONL line (including trailing newline). */
  readonly line: string;
}

export interface CrashLogWindowSnapshot {
  readonly windowMs: number;
  readonly recordCount: number;
  readonly byteSize: number;
  readonly oldestTs: string | null;
  readonly newestTs: string | null;
  /** Newline-delimited JSONL of every record currently in the window. */
  readonly text: string;
}

export interface CrashLogWindowSummary {
  readonly windowMs: number;
  readonly recordCount: number;
  readonly byteSize: number;
  readonly oldestTs: string | null;
  readonly newestTs: string | null;
  readonly levelCounts: Record<string, number>;
  readonly componentCounts: Record<string, number>;
  readonly recentIssues: ReadonlyArray<{
    readonly ts: string;
    readonly level: string;
    readonly component: string;
    readonly message: string;
  }>;
}

export interface CrashRingOptions {
  readonly windowMs?: number;
  readonly maxRecords?: number;
  readonly maxBytes?: number;
  readonly summaryMaxRecent?: number;
  readonly summaryTopComponents?: number;
}

export declare class CrashRing {
  constructor(options?: CrashRingOptions);
  append(input: CrashRingEntryInput): void;
  snapshot(nowMs: number): CrashLogWindowSnapshot;
  summary(nowMs: number): CrashLogWindowSummary;
}

export declare function emptyCrashLogWindowSummary(windowMs?: number): CrashLogWindowSummary;
