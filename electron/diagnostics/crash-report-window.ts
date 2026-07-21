import { BrowserWindow, nativeTheme } from "electron";
import {
  CRASH_CONSENT_DECLINED,
  parseCrashConsentUrl,
  renderCrashConsentHtml,
  type CrashReportConsent,
} from "@ambient/shared/observability";
import { excludeWindowFromSelfCapture } from "@ambient/shared/window-capture";
import type { BridgeCrashReportMarker } from "./crash-report.js";

export type { CrashReportConsent };

const EVENT_SCHEME = "ambient-bridge-crash-report:";
const WINDOW_WIDTH = 460;
const WINDOW_HEIGHT = 430;
const NOTE_MAX_LENGTH = 2_000;

/**
 * Show a small modal asking the user whether to send a Bridge crash report,
 * with an optional note and a toggle for attaching the diagnostic log window.
 * Resolves to a decline if the window is closed without a choice or fails to
 * open. Same dialog (shared HTML) as the Ambient app's crash consent prompt.
 */
export async function promptBridgeCrashReportConsent(
  marker: BridgeCrashReportMarker,
  onError: (message: string) => void,
): Promise<CrashReportConsent> {
  let settled = false;
  return new Promise<CrashReportConsent>((resolve) => {
    let window: BrowserWindow;
    try {
      window = new BrowserWindow({
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        title: "Ambient Bridge quit unexpectedly",
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      excludeWindowFromSelfCapture(window);
    } catch (error) {
      onError(`failed to create crash report window: ${error instanceof Error ? error.message : String(error)}`);
      resolve(CRASH_CONSENT_DECLINED);
      return;
    }

    const settle = (consent: CrashReportConsent): void => {
      if (settled) return;
      settled = true;
      resolve(consent);
      if (!window.isDestroyed()) window.close();
    };

    window.webContents.setWindowOpenHandler(({ url }) => {
      handleUrl(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(EVENT_SCHEME)) return;
      event.preventDefault();
      handleUrl(url);
    });
    window.once("closed", () => settle(CRASH_CONSENT_DECLINED));

    const html = renderCrashConsentHtml({
      title: "Ambient Bridge quit unexpectedly",
      errorLabel: `${marker.exception.type}: ${marker.exception.message}`,
      whenLabel: new Date(marker.createdAtMs).toLocaleString(),
      origin: marker.origin,
      errorCode: marker.exception.code,
      dark: nativeTheme.shouldUseDarkColors,
      eventScheme: EVENT_SCHEME,
      noteMaxLength: NOTE_MAX_LENGTH,
    });
    void window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .then(() => {
        if (!window.isDestroyed()) window.show();
      })
      .catch((error) => {
        onError(`failed to load crash report window: ${error instanceof Error ? error.message : String(error)}`);
        settle(CRASH_CONSENT_DECLINED);
      });

    function handleUrl(url: string): void {
      settle(parseCrashConsentUrl(url, EVENT_SCHEME, NOTE_MAX_LENGTH) ?? CRASH_CONSENT_DECLINED);
    }
  });
}
