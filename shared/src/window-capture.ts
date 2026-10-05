/**
 * Shared helper for keeping Ambient-owned windows out of Ambient's own screen
 * capture. Consumed by the Electron main process in both `@ambient/app` and
 * `@ambient/bridge`. Authored in TypeScript and bundled into each product's
 * Vite Electron main entry.
 */

/**
 * A window that can be excluded from OS screen capture. Electron's BrowserWindow
 * satisfies this shape structurally, so this browser-safe module never depends on
 * electron.
 */
export interface CaptureExcludableWindow {
  isDestroyed(): boolean;
  setContentProtection(enable: boolean): void;
}

/**
 * Marks an Ambient-owned window (main window, Bridge window, live-recording
 * overlay, toasts, popups, diagnostics windows, ...) as one that must be kept out
 * of Ambient's own screen capture.
 *
 * Exclusion is enforced capture-side by *process id*, not per window: the capture
 * request carries `excludedApplicationPids` (Ambient's own UI process ids) and the
 * native capture layer can omit those processes' windows from each frame — macOS
 * via ScreenCaptureKit's application exclusion, Windows by blacking out those
 * windows' rectangles in the DXGI/GDI buffer before encoding. Ambient's Settings
 * toggle `capture.hideAmbientWindows` (off by default) decides whether those
 * PIDs are sent. When the toggle is on, Ambient windows remain fully visible to
 * the user's own screenshots and screen shares, unlike the old
 * WDA_EXCLUDEFROMCAPTURE approach.
 *
 * This helper is therefore a no-op today — no window-level content protection is
 * applied. It is kept (and still called at window creation) as the documented seam
 * for "this window is Ambient-owned and must not be self-captured"; the owning
 * process id must be present in `captureExcludedApplicationPids()` (see the app's
 * main process), and Settings must have Hide Ambient windows on, for capture
 * exclusion to apply.
 *
 * @returns always false — window-level content protection is no longer used
 */
export function excludeWindowFromSelfCapture(
  window: CaptureExcludableWindow,
  platform: NodeJS.Platform = process.platform,
): boolean {
  void window;
  void platform;
  return false;
}
