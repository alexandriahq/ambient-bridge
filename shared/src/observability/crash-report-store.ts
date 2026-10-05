import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { emptyCrashLogWindowSummary, type CrashLogWindowSummary } from "./crash-ring.js";

/**
 * On-disk marker store shared by the Ambient app and Bridge: each snapshot is a
 * small JSON marker plus a JSONL window of the last ~30s of records, written
 * synchronously so it is safe inside an uncaughtException handler. Markers
 * survive the process as bounded local diagnostic artifacts.
 *
 * Authored in TypeScript; see crash-ring.ts for the packaging convention.
 */

export interface CrashExceptionSummary {
  readonly type: string;
  readonly message: string;
  readonly stack: string | null;
  readonly code: string | null;
  readonly syscall: string | null;
}

export interface MarkerBase {
  readonly version: number;
  readonly id: string;
  readonly createdAtMs: number;
  readonly windowSummary: CrashLogWindowSummary;
  /** Absolute path to the full JSONL window persisted alongside the marker. */
  readonly windowFile: string;
}

export interface MarkerStoreOptions<TMarker extends MarkerBase> {
  readonly dir: string;
  readonly idPrefix: string;
  readonly markerSuffix: string;
  readonly windowSuffix: string;
  readonly version: number;
  readonly maxPending: number;
  readonly isMarker: (parsed: unknown) => parsed is TMarker;
}

export interface WriteMarkerInput<TMarker extends MarkerBase> {
  readonly nowMs?: number;
  /** Snapshot of the rolling window; failures fall back to an empty summary. */
  readonly window: () => { readonly text: string; readonly summary: CrashLogWindowSummary };
  /** Assemble the concrete marker from the base fields. */
  readonly buildMarker: (base: MarkerBase) => TMarker;
}

export interface MarkerStore<TMarker extends MarkerBase> {
  /** Persist synchronously; swallows its own errors, returns null on failure. */
  readonly write: (input: WriteMarkerInput<TMarker>) => TMarker | null;
  /** All pending markers, newest first; prunes beyond maxPending. */
  readonly listPending: () => readonly TMarker[];
  readonly delete: (id: string) => void;
  /** Read the marker's JSONL window (best-effort, tail-capped). */
  readonly readWindowText: (marker: TMarker, maxBytes?: number) => string | null;
}

export function createMarkerStore<TMarker extends MarkerBase>(
  options: MarkerStoreOptions<TMarker>,
): MarkerStore<TMarker> {
  const remove = (id: string): void => {
    for (const suffix of [options.markerSuffix, options.windowSuffix]) {
      try {
        rmSync(path.join(options.dir, `${id}${suffix}`), { force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  };

  const listPending = (): readonly TMarker[] => {
    let names: string[];
    try {
      names = readdirSync(options.dir);
    } catch {
      return [];
    }
    const markers: TMarker[] = [];
    for (const name of names) {
      if (!name.endsWith(options.markerSuffix)) continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(path.join(options.dir, name), "utf8"));
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
        let windowSummary: CrashLogWindowSummary;
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

export function isMarkerBase(value: unknown): value is MarkerBase {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.version === "number"
    && typeof record.id === "string"
    && typeof record.createdAtMs === "number"
    && typeof record.windowFile === "string"
    && typeof record.windowSummary === "object" && record.windowSummary !== null;
}

type ErrorLike = {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly reason?: unknown;
  readonly stack?: unknown;
  readonly code?: unknown;
  readonly syscall?: unknown;
};

export function crashExceptionSummary(error: unknown): CrashExceptionSummary {
  if (error instanceof Error) {
    const errorLike = error as Error & ErrorLike;
    return {
      type: error.name || "Error",
      message: error.message.slice(0, 1_000),
      stack: error.stack ? error.stack.slice(0, 12_000) : null,
      code: typeof errorLike.code === "string" ? errorLike.code : null,
      syscall: typeof errorLike.syscall === "string" ? errorLike.syscall : null,
    };
  }
  if (error && typeof error === "object") {
    const errorLike = error as ErrorLike;
    return {
      type: typeof errorLike.name === "string" ? errorLike.name : "Error",
      message: String(errorLike.message ?? errorLike.reason ?? error).slice(0, 1_000),
      stack: typeof errorLike.stack === "string" ? errorLike.stack.slice(0, 12_000) : null,
      code: typeof errorLike.code === "string" ? errorLike.code : null,
      syscall: typeof errorLike.syscall === "string" ? errorLike.syscall : null,
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
