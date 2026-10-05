export const BRIDGE_AUTH_PROTOCOL_SCHEME = "ambient-bridge";

/**
 * Decide whether WorkOS should redirect to a one-shot 127.0.0.1 listener
 * (`loopback`) or the `ambient-bridge://` custom scheme (`protocol`).
 *
 * Packaged Windows and Linux prefer loopback: browser → custom-scheme handoff
 * is fragile (Start menu / xdg-open desktop entries). Packaged macOS keeps the
 * custom scheme. Unpackaged / `AMBIENT_BRIDGE_AUTH_CALLBACK_MODE` overrides win.
 */
export function shouldUseLoopbackAuthCallback(input: {
  readonly env?: Record<string, string | undefined>;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
}): boolean {
  const mode = input.env?.AMBIENT_BRIDGE_AUTH_CALLBACK_MODE?.trim().toLowerCase();
  if (mode === "protocol") return false;
  if (mode === "loopback") return true;
  if (input.platform === "win32" || input.platform === "linux") return true;
  return !input.isPackaged;
}

/** Pull an `ambient-bridge://…` URL out of a second-instance argv list. */
export function authCallbackUrlFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const trimmed = arg.trim();
    if (trimmed.startsWith(`${BRIDGE_AUTH_PROTOCOL_SCHEME}://`)) return trimmed;
  }
  return null;
}
