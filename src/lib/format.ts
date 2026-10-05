import type {
  BridgeConnectionState,
  BridgeInferenceProxyPath,
} from "./bridge-api";

export function formatRelative(value: number, now: number): string {
  const deltaMs = now - value;
  if (deltaMs < 1_000) return "just now";
  const seconds = Math.floor(deltaMs / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

const ROUTE_LABELS: Record<BridgeInferenceProxyPath, string> = {
  "/v1/audio/transcriptions": "Transcription",
  "/v1/chat/completions": "Chat",
  "/v1/responses": "Responses",
  "/v1/embeddings": "Embeddings",
};

export function routeLabel(path: BridgeInferenceProxyPath | string): string {
  return ROUTE_LABELS[path as BridgeInferenceProxyPath] ?? path;
}

export function connectionLabel(connection: BridgeConnectionState): string {
  if (connection === "checking") return "Checking";
  return connection.replaceAll("_", " ");
}

export function hostFromOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
