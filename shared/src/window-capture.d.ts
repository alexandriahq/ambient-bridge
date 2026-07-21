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
 * Marks an Ambient-owned window as one that must be kept out of Ambient's own
 * screen capture. Exclusion is enforced capture-side by *process id* (via the
 * capture request's `excludedApplicationPids`), not per window — macOS through
 * ScreenCaptureKit, Windows by masking those processes' window rectangles in the
 * captured frame. Both native paths are currently disabled by in-code rollout
 * flags. When enabled, Ambient windows stay visible to the user's own screenshots
 * and screen shares.
 *
 * This helper is a no-op today (window-level content protection is no longer
 * used); it remains as the documented seam at window creation. The owning process
 * id must be in `captureExcludedApplicationPids()` and the platform-native flag
 * must be enabled for capture exclusion to apply.
 *
 * @returns always false — window-level content protection is no longer applied.
 */
export declare function excludeWindowFromSelfCapture(
  window: CaptureExcludableWindow,
  platform?: NodeJS.Platform,
): boolean;
