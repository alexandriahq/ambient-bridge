import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { emptyCrashLogWindowSummary } from "./crash-ring.js";

/**
 * On-disk marker store shared by the Ambient app and Bridge: each snapshot is a
 * small JSON marker plus a JSONL window of the last ~30s of records, written
 * synchronously so it is safe inside an uncaughtException handler. Markers
 * survive the process and drive the next-launch consent prompt.
 *
 * Plain ESM JavaScript (types in crash-report-store.d.ts); see crash-ring.js
 * for why.
 */

export function createMarkerStore(options) {
  const remove = (id) => {
    for (const suffix of [options.markerSuffix, options.windowSuffix]) {
      try {
        rmSync(path.join(options.dir, `${id}${suffix}`), { force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  };

  const listPending = () => {
    let names;
    try {
      names = readdirSync(options.dir);
    } catch {
      return [];
    }
    const markers = [];
    for (const name of names) {
      if (!name.endsWith(options.markerSuffix)) continue;
      try {
        const parsed = JSON.parse(readFileSync(path.join(options.dir, name), "utf8"));
        if (options.isMarker(parsed) && parsed.version === options.version) markers.push(parsed);
      } catch {
        // Ignore corrupt markers; they age out via pruning below.
      }
    }
    markers.sort((a, b) => b.createdAtMs - a.createdAtMs);
    if (markers.length > options.maxPending) {
      for (const stale of markers.slice(options.maxPending)) remove(stale.id);
      return markers.slice(0, options.maxPending);
    }
    return markers;
  };

  return {
    write: (input) => {
      const nowMs = input.nowMs ?? Date.now();
      const id = `${options.idPrefix}_${nowMs.toString(36)}_${randomUUID().slice(0, 8)}`;
      const windowFile = path.join(options.dir, `${id}${options.windowSuffix}`);
      const markerFile = path.join(options.dir, `${id}${options.markerSuffix}`);
      try {
        mkdirSync(options.dir, { recursive: true });
        let windowSummary;
        try {
          const window = input.window();
          windowSummary = window.summary;
          writeFileSync(windowFile, window.text, "utf8");
        } catch {
          windowSummary = emptyCrashLogWindowSummary();
        }
        const marker = input.buildMarker({
          version: options.version,
          id,
          createdAtMs: nowMs,
          windowSummary,
          windowFile,
        });
        writeFileSync(markerFile, JSON.stringify(marker), "utf8");
        return marker;
      } catch {
        return null;
      }
    },
    listPending,
    delete: remove,
    readWindowText: (marker, maxBytes = 256 * 1024) => {
      try {
        const text = readFileSync(marker.windowFile, "utf8");
        return text.length > maxBytes ? text.slice(text.length - maxBytes) : text;
      } catch {
        return null;
      }
    },
  };
}

export function isMarkerBase(value) {
  if (!value || typeof value !== "object") return false;
  return typeof value.version === "number"
    && typeof value.id === "string"
    && typeof value.createdAtMs === "number"
    && typeof value.windowFile === "string"
    && typeof value.windowSummary === "object" && value.windowSummary !== null;
}

export function crashExceptionSummary(error) {
  if (error instanceof Error) {
    return {
      type: error.name || "Error",
      message: error.message.slice(0, 1_000),
      stack: error.stack ? error.stack.slice(0, 12_000) : null,
      code: typeof error.code === "string" ? error.code : null,
      syscall: typeof error.syscall === "string" ? error.syscall : null,
    };
  }
  if (error && typeof error === "object") {
    return {
      type: typeof error.name === "string" ? error.name : "Error",
      message: String(error.message ?? error.reason ?? error).slice(0, 1_000),
      stack: typeof error.stack === "string" ? error.stack.slice(0, 12_000) : null,
      code: typeof error.code === "string" ? error.code : null,
      syscall: typeof error.syscall === "string" ? error.syscall : null,
    };
  }
  return {
    type: "Error",
    message: String(error).slice(0, 1_000),
    stack: null,
    code: null,
    syscall: null,
  };
}

/**
 * Component names go into telemetry as *values*, never as object keys: names
 * like `ambient-capture` match the forbidden-key pattern and would be silently
 * dropped by the sanitizer (client) or reject the event outright (server).
 */
export function componentCountEntries(counts) {
  return Object.entries(counts).map(([component, count]) => ({ component, count }));
}

/**
 * Flatten a crash marker (plus optional user note) into telemetry-safe
 * properties for a `*.crashReport` event. Property keys avoid the server's
 * forbidden-key pattern; the client-side sanitizer further bounds value sizes.
 * The per-level/component breakdown and recent warning/error lines are attached
 * only when the user opted to include diagnostic logs.
 */
export function crashReportTelemetryProperties(marker, options) {
  const note = typeof options.note === "string"
    ? options.note.trim().slice(0, options.noteMaxLength ?? 2_000)
    : "";
  const base = {
    crashId: marker.id,
    origin: marker.origin,
    crashedAtMs: marker.createdAtMs,
    reportedAtMs: options.reportedAtMs,
    delaySec: Math.round((options.reportedAtMs - marker.createdAtMs) / 1_000),
    release: marker.appVersion,
    errorCode: marker.exception.code,
    errorSyscall: marker.exception.syscall,
    logWindowIncluded: options.logWindowIncluded,
    logWindowRecords: marker.windowSummary.recordCount,
    logWindowOldestTs: marker.windowSummary.oldestTs,
    logWindowNewestTs: marker.windowSummary.newestTs,
    crashContext: marker.context,
    userNote: note,
    userNotePresent: note.length > 0,
  };
  if (!options.logWindowIncluded) return base;
  return {
    ...base,
    logLevelCounts: marker.windowSummary.levelCounts,
    logComponentCounts: componentCountEntries(marker.windowSummary.componentCounts),
    recentIssues: marker.windowSummary.recentIssues,
  };
}
