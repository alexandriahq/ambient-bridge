import type {
  BridgeActivityEvent,
  BridgeConnectionState,
  BridgeInferenceProxyPath,
  BridgeServerReachabilityState,
} from "./bridge-api";

export function formatClock(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

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

export function shortId(value: string | null | undefined, length = 8): string {
  if (!value) return "—";
  return value.length > length ? value.slice(0, length) : value;
}

const ROUTE_LABELS: Record<BridgeInferenceProxyPath, string> = {
  "/v1/audio/transcriptions": "Transcription",
  "/v1/chat/completions": "Chat",
  "/v1/responses": "Responses",
};

export function routeLabel(path: BridgeInferenceProxyPath | string): string {
  return ROUTE_LABELS[path as BridgeInferenceProxyPath] ?? path;
}

/** Prefix before the first dot, used as the log category tag (e.g. "inference"). */
export function eventCategory(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

/** "inference.secure_fetch_response" -> "Secure fetch response" */
export function humanizeEventName(name: string): string {
  const dot = name.indexOf(".");
  const tail = dot === -1 ? name : name.slice(dot + 1);
  const words = tail.replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatEventFields(event: BridgeActivityEvent): string {
  return Object.entries(event.fields)
    .filter(([key, value]) => value !== undefined && value !== null && key !== "level")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("  ");
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function connectionLabel(connection: BridgeConnectionState): string {
  if (connection === "checking") return "Checking";
  return connection.replaceAll("_", " ");
}

export function ipcLabel(socketReady: boolean): string {
  return socketReady ? "Listening" : "Starting";
}

export function serverReachabilityLabel(state: BridgeServerReachabilityState): string {
  if (state === "checking") return "Checking";
  if (state === "reachable") return "Reachable";
  return "Unavailable";
}

export function hostFromOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * Render base64-encoded ciphertext as a Wireshark-style hex dump
 * (`offset  hex bytes  ascii`), capped at `maxBytes` rendered bytes.
 */
export function hexDump(base64: string, maxBytes = 512): { text: string; shown: number; total: number } {
  if (!base64) return { shown: 0, text: "", total: 0 };
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return { shown: 0, text: "", total: 0 };
  }
  const total = binary.length;
  const shown = Math.min(total, maxBytes);
  const lines: string[] = [];
  for (let offset = 0; offset < shown; offset += 16) {
    const end = Math.min(offset + 16, shown);
    let hex = "";
    let ascii = "";
    for (let i = 0; i < 16; i += 1) {
      const index = offset + i;
      if (index < end) {
        const code = binary.charCodeAt(index);
        hex += code.toString(16).padStart(2, "0");
        ascii += code >= 32 && code < 127 ? binary[index] : ".";
      } else {
        hex += "  ";
      }
      hex += i === 7 ? "  " : " ";
    }
    lines.push(`${offset.toString(16).padStart(4, "0")}  ${hex} ${ascii}`);
  }
  return { shown, text: lines.join("\n"), total };
}
