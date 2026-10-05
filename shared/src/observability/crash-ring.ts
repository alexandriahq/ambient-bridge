/**
 * Rolling in-memory window of recent structured log records, kept so that a
 * crash can persist "what the app was doing in the seconds before it died".
 * Shared by the Ambient app (fed from its Effect logger sinks) and Bridge (fed
 * from its audit sink). Bounded by time, record count, and total bytes so it
 * can never grow unbounded; strictly best-effort and side-effect free.
 *
 * Authored in TypeScript and bundled into each product's Vite Electron main
 * entry — same convention as ../update-core.ts.
 */

const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_MAX_RECORDS = 4_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_SUMMARY_MAX_RECENT = 12;
const DEFAULT_SUMMARY_TOP_COMPONENTS = 8;

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

interface CrashRingEntry extends CrashRingEntryInput {
  readonly bytes: number;
}

export class CrashRing {
  #windowMs: number;
  #maxRecords: number;
  #maxBytes: number;
  #summaryMaxRecent: number;
  #summaryTopComponents: number;
  #entries: CrashRingEntry[] = [];
  #head = 0;
  #bytes = 0;

  constructor(options: CrashRingOptions = {}) {
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#summaryMaxRecent = options.summaryMaxRecent ?? DEFAULT_SUMMARY_MAX_RECENT;
    this.#summaryTopComponents = options.summaryTopComponents ?? DEFAULT_SUMMARY_TOP_COMPONENTS;
  }

  append(input: CrashRingEntryInput): void {
    try {
      const bytes = Buffer.byteLength(input.line, "utf8");
      this.#entries.push({ ...input, bytes });
      this.#bytes += bytes;
      this.#evict(input.atMs);
    } catch {
      // The crash window must never disrupt logging.
    }
  }

  /** Snapshot the rolling window as newline-delimited JSONL plus light metadata. */
  snapshot(nowMs: number): CrashLogWindowSnapshot {
    const entries = this.#live(nowMs);
    return {
      windowMs: this.#windowMs,
      recordCount: entries.length,
      byteSize: entries.reduce((total, entry) => total + entry.bytes, 0),
      oldestTs: entries.length > 0 ? new Date(entries[0]!.atMs).toISOString() : null,
      newestTs: entries.length > 0 ? new Date(entries[entries.length - 1]!.atMs).toISOString() : null,
      text: entries.map((entry) => entry.line).join(""),
    };
  }

  /** Compact, sanitized summary of the rolling window (counts + recent issues). */
  summary(nowMs: number): CrashLogWindowSummary {
    const entries = this.#live(nowMs);
    const levelCounts: Record<string, number> = {};
    const componentCountsAll: Record<string, number> = {};
    for (const entry of entries) {
      levelCounts[entry.level] = (levelCounts[entry.level] ?? 0) + 1;
      componentCountsAll[entry.component] = (componentCountsAll[entry.component] ?? 0) + 1;
    }
    const componentCounts: Record<string, number> = {};
    for (const [component, count] of Object.entries(componentCountsAll)
      .sort((a, b) => b[1]! - a[1]!)
      .slice(0, this.#summaryTopComponents)) {
      componentCounts[component] = count!;
    }
    const recentIssues = entries
      .filter((entry) => entry.level === "WARN" || entry.level === "ERROR" || entry.level === "FATAL")
      .slice(-this.#summaryMaxRecent)
      .map((entry) => ({
        ts: new Date(entry.atMs).toISOString(),
        level: entry.level,
        component: entry.component,
        message: entry.message,
      }));
    return {
      windowMs: this.#windowMs,
      recordCount: entries.length,
      byteSize: entries.reduce((total, entry) => total + entry.bytes, 0),
      oldestTs: entries.length > 0 ? new Date(entries[0]!.atMs).toISOString() : null,
      newestTs: entries.length > 0 ? new Date(entries[entries.length - 1]!.atMs).toISOString() : null,
      levelCounts,
      componentCounts,
      recentIssues,
    };
  }

  #live(nowMs: number): CrashRingEntry[] {
    this.#evict(nowMs);
    return this.#entries.slice(this.#head);
  }

  #evict(nowMs: number): void {
    const cutoff = nowMs - this.#windowMs;
    while (this.#head < this.#entries.length) {
      const entry = this.#entries[this.#head]!;
      const expired = entry.atMs < cutoff;
      const overCount = this.#entries.length - this.#head > this.#maxRecords;
      const overBytes = this.#bytes > this.#maxBytes;
      if (!expired && !overCount && !overBytes) break;
      this.#bytes -= entry.bytes;
      this.#head += 1;
    }
    // Compact the backing array once the dead prefix grows, so it never leaks.
    if (this.#head > 0 && (this.#head >= this.#entries.length || this.#head > 1_024)) {
      this.#entries.splice(0, this.#head);
      this.#head = 0;
    }
  }
}

export function emptyCrashLogWindowSummary(windowMs = DEFAULT_WINDOW_MS): CrashLogWindowSummary {
  return {
    windowMs,
    recordCount: 0,
    byteSize: 0,
    oldestTs: null,
    newestTs: null,
    levelCounts: {},
    componentCounts: {},
    recentIssues: [],
  };
}
