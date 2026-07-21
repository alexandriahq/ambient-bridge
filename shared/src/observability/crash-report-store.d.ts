import type { CrashLogWindowSummary } from "./crash-ring.js";

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

export declare function createMarkerStore<TMarker extends MarkerBase>(
  options: MarkerStoreOptions<TMarker>,
): MarkerStore<TMarker>;

export declare function isMarkerBase(value: unknown): value is MarkerBase;

export declare function crashExceptionSummary(error: unknown): CrashExceptionSummary;

export declare function componentCountEntries(
  counts: Record<string, number>,
): ReadonlyArray<{ readonly component: string; readonly count: number }>;

export interface CrashReportMarkerShape extends MarkerBase {
  readonly origin: string;
  readonly appVersion: string;
  readonly exception: CrashExceptionSummary;
  readonly context: Record<string, unknown>;
}

export declare function crashReportTelemetryProperties(
  marker: CrashReportMarkerShape,
  options: {
    readonly note?: string | null;
    readonly reportedAtMs: number;
    readonly logWindowIncluded: boolean;
    readonly noteMaxLength?: number;
  },
): Record<string, unknown>;
