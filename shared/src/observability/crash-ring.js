/**
 * Rolling in-memory window of recent structured log records, kept so that a
 * crash can persist "what the app was doing in the seconds before it died".
 * Shared by the Ambient app (fed from its Effect logger sinks) and Bridge (fed
 * from its audit sink). Bounded by time, record count, and total bytes so it
 * can never grow unbounded; strictly best-effort and side-effect free.
 *
 * Plain ESM JavaScript (types in crash-ring.d.ts) because Bridge's electron
 * main is compiled with tsc and loads shared modules as real JS at runtime —
 * same convention as ../compact-auth-window.js.
 */

const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_MAX_RECORDS = 4_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_SUMMARY_MAX_RECENT = 12;
const DEFAULT_SUMMARY_TOP_COMPONENTS = 8;

export class CrashRing {
  #windowMs;
  #maxRecords;
  #maxBytes;
  #summaryMaxRecent;
  #summaryTopComponents;
  #entries = [];
  #head = 0;
  #bytes = 0;

  constructor(options = {}) {
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#summaryMaxRecent = options.summaryMaxRecent ?? DEFAULT_SUMMARY_MAX_RECENT;
    this.#summaryTopComponents = options.summaryTopComponents ?? DEFAULT_SUMMARY_TOP_COMPONENTS;
  }

  append(input) {
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
  snapshot(nowMs) {
    const entries = this.#live(nowMs);
    return {
      windowMs: this.#windowMs,
      recordCount: entries.length,
      byteSize: entries.reduce((total, entry) => total + entry.bytes, 0),
      oldestTs: entries.length > 0 ? new Date(entries[0].atMs).toISOString() : null,
      newestTs: entries.length > 0 ? new Date(entries[entries.length - 1].atMs).toISOString() : null,
      text: entries.map((entry) => entry.line).join(""),
    };
  }

  /** Compact, telemetry-safe summary of the rolling window (counts + recent issues). */
  summary(nowMs) {
    const entries = this.#live(nowMs);
    const levelCounts = {};
    const componentCountsAll = {};
    for (const entry of entries) {
      levelCounts[entry.level] = (levelCounts[entry.level] ?? 0) + 1;
      componentCountsAll[entry.component] = (componentCountsAll[entry.component] ?? 0) + 1;
    }
    const componentCounts = {};
    for (const [component, count] of Object.entries(componentCountsAll)
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.#summaryTopComponents)) {
      componentCounts[component] = count;
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
      oldestTs: entries.length > 0 ? new Date(entries[0].atMs).toISOString() : null,
      newestTs: entries.length > 0 ? new Date(entries[entries.length - 1].atMs).toISOString() : null,
      levelCounts,
      componentCounts,
      recentIssues,
    };
  }

  #live(nowMs) {
    this.#evict(nowMs);
    return this.#entries.slice(this.#head);
  }

  #evict(nowMs) {
    const cutoff = nowMs - this.#windowMs;
    while (this.#head < this.#entries.length) {
      const entry = this.#entries[this.#head];
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

export function emptyCrashLogWindowSummary(windowMs = DEFAULT_WINDOW_MS) {
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
