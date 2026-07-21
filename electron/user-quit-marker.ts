import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Marker file the Ambient app's Bridge auto-launcher respects: while present,
 * a missing Bridge means "the user explicitly quit Bridge", not "Bridge
 * crashed", so auto-start must not fight the quit. Bridge writes it on
 * explicit quits (tray/menu/Cmd+Q) only — never on OS shutdown or update
 * restarts — and every Bridge start clears it. The Ambient app also clears it
 * on its own startup so a fresh Ambient session re-enables auto-start.
 */
export const BRIDGE_USER_QUIT_MARKER_FILENAME = "bridge.user-quit.json";

export function bridgeUserQuitMarkerPath(supportDir: string): string {
  return join(supportDir, BRIDGE_USER_QUIT_MARKER_FILENAME);
}

export function writeBridgeUserQuitMarker(supportDir: string, nowMs = Date.now()): void {
  mkdirSync(supportDir, { recursive: true });
  writeFileSync(
    bridgeUserQuitMarkerPath(supportDir),
    `${JSON.stringify({ quitAtMs: nowMs, reason: "user_quit" })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export function clearBridgeUserQuitMarker(supportDir: string): void {
  rmSync(bridgeUserQuitMarkerPath(supportDir), { force: true });
}
