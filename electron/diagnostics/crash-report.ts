import {
  crashExceptionSummary,
  createMarkerStore,
  isMarkerBase,
  type CrashExceptionSummary,
  type CrashLogWindowSummary,
  type MarkerStore,
} from "@ambient/shared/observability";
import type { BridgeCrashOrigin } from "./crash-telemetry.js";

// Bridge binding of the shared crash-report architecture: markers + 30s JSONL
// windows under <userData>/crashes, written synchronously at crash time and
// offered for submission (with consent) on the next launch — the same flow as
// the Ambient app.

const CRASH_MARKER_VERSION = 1 as const;
const MAX_PENDING_CRASH_REPORTS = 20;

export interface BridgeCrashReportMarker {
  readonly version: typeof CRASH_MARKER_VERSION;
  readonly id: string;
  readonly createdAtMs: number;
  readonly origin: BridgeCrashOrigin;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly exception: CrashExceptionSummary;
  readonly windowSummary: CrashLogWindowSummary;
  /** Absolute path to the full 30s JSONL window persisted alongside the marker. */
  readonly windowFile: string;
  readonly context: Record<string, unknown>;
}

export interface WriteBridgeCrashSnapshotInput {
  readonly origin: BridgeCrashOrigin;
  readonly error: unknown;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly nowMs?: number;
}

export interface BridgeCrashReportStore {
  /** Persist synchronously; safe inside an uncaughtException handler. */
  readonly writeSnapshotSync: (input: WriteBridgeCrashSnapshotInput) => BridgeCrashReportMarker | null;
  /** Pending markers, newest first; prunes beyond the retention cap. */
  readonly listPending: () => readonly BridgeCrashReportMarker[];
  readonly delete: (id: string) => void;
}

export function createBridgeCrashReportStore(options: {
  readonly dir: string;
  readonly window: (nowMs: number) => { readonly text: string; readonly summary: CrashLogWindowSummary };
}): BridgeCrashReportStore {
  const store: MarkerStore<BridgeCrashReportMarker> = createMarkerStore<BridgeCrashReportMarker>({
    dir: options.dir,
    idPrefix: "crash",
    markerSuffix: ".crash.json",
    windowSuffix: ".window.jsonl",
    version: CRASH_MARKER_VERSION,
    maxPending: MAX_PENDING_CRASH_REPORTS,
    isMarker: (parsed): parsed is BridgeCrashReportMarker =>
      isMarkerBase(parsed) && typeof (parsed as BridgeCrashReportMarker).origin === "string",
  });
  return {
    writeSnapshotSync: (input) => {
      const nowMs = input.nowMs ?? Date.now();
      return store.write({
        nowMs,
        window: () => options.window(nowMs),
        buildMarker: (base) => ({
          ...base,
          version: CRASH_MARKER_VERSION,
          origin: input.origin,
          appVersion: input.appVersion,
          platform: input.platform,
          exception: crashExceptionSummary(input.error),
          context: {},
        }),
      });
    },
    listPending: () => store.listPending(),
    delete: (id) => store.delete(id),
  };
}
