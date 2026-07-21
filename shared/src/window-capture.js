// Shared helper for keeping Ambient-owned windows out of Ambient's own screen
// capture. Consumed by the Electron main process in both @ambient/app and
// @ambient/bridge, so it ships as hand-written .js + .d.ts (the bridge runs its
// main process straight through tsc/Node and resolves this at runtime, exactly
// like ./compact-auth-window and ./update-core).

/**
 * Marks an Ambient-owned window (main window, Bridge window, live-recording
 * overlay, toasts, popups, diagnostics windows, ...) as one that must be kept out
 * of Ambient's own screen capture.
 *
 * Exclusion is enforced capture-side by *process id*, not per window: the capture
 * request carries `excludedApplicationPids` (Ambient's own UI process ids) and the
 * native capture layer can omit those processes' windows from each frame — macOS
 * via ScreenCaptureKit's application exclusion, Windows by blacking out those
 * windows' rectangles in the DXGI/GDI buffer before encoding. Both native paths
 * currently keep that behavior behind disabled in-code rollout flags. When
 * enabled, Ambient windows remain fully visible to the user's own screenshots
 * and screen shares, unlike the old WDA_EXCLUDEFROMCAPTURE approach.
 *
 * This helper is therefore a no-op today — no window-level content protection is
 * applied. It is kept (and still called at window creation) as the documented seam
 * for "this window is Ambient-owned and must not be self-captured"; the owning
 * process id must be present in `captureExcludedApplicationPids()` (see the app's
 * main process), and the platform-native rollout flag must be enabled, for
 * capture exclusion to apply.
 *
 * The window is typed structurally so this browser-safe module never has to depend
 * on electron; an Electron BrowserWindow satisfies the shape directly.
 *
 * @param {{ isDestroyed(): boolean, setContentProtection(enable: boolean): void }} window
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean} always false — window-level content protection is no longer used
 */
export function excludeWindowFromSelfCapture(window, platform = process.platform) {
  void window;
  void platform;
  return false;
}
