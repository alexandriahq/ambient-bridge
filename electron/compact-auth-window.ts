import { screen, systemPreferences, type BrowserWindow, type Display, type Rectangle } from "electron";
import {
  COMPACT_AUTH_WINDOW_BLACKOUT_LEAD_MS,
  COMPACT_AUTH_WINDOW_EVENT_SCHEME,
  COMPACT_AUTH_WINDOW_TRANSITION_FRAME_MS,
  COMPACT_AUTH_WINDOW_TRANSITION_MS,
  compactAuthWindowBlackoutHtml,
  compactAuthWindowBounds,
  compactAuthWindowHtml,
  compactAuthWindowTransitionBounds,
} from "@ambient/shared/compact-auth-window";

const CANCEL_URL = `${COMPACT_AUTH_WINDOW_EVENT_SCHEME}//auth/cancel`;

type CompactAuthWindowOptions = {
  readonly appName: string;
  readonly title?: string;
  readonly detail?: string;
  readonly anchorWindow?: BrowserWindow | null;
  readonly onCancel?: () => void;
  readonly onRestore?: () => void;
  readonly onRestoreLoadFailed?: (window: BrowserWindow) => void;
};

type CompactAuthRestoreState = {
  readonly alwaysOnTop: boolean;
  readonly backgroundColor: string;
  readonly bounds: Rectangle;
  readonly fullScreen: boolean;
  readonly fullScreenable: boolean;
  readonly maximizable: boolean;
  readonly maximized: boolean;
  readonly maximumSize: readonly [number, number];
  readonly menuBarAutoHide: boolean;
  readonly menuBarVisible: boolean;
  readonly minimizable: boolean;
  readonly minimized: boolean;
  readonly minimumSize: readonly [number, number];
  readonly movable: boolean;
  readonly resizable: boolean;
  readonly title: string;
  readonly url: string | null;
  readonly visible: boolean;
};

type CompactAuthSession = {
  readonly closeListener: (event: { preventDefault(): void }) => void;
  readonly closedListener: () => void;
  readonly navigateListener: (event: { preventDefault(): void }, url: string) => void;
  readonly restore: CompactAuthRestoreState;
  readonly window: BrowserWindow;
};

let compactAuthSession: CompactAuthSession | null = null;
let compactAuthAnchorWindow: BrowserWindow | null = null;
let compactAuthOnCancel: (() => void) | null = null;
let compactAuthOnRestore: (() => void) | null = null;
let compactAuthOnRestoreLoadFailed: ((window: BrowserWindow) => void) | null = null;
let compactAuthLastHtml: string | null = null;
let compactAuthRestoring = false;
let compactAuthTransitionId = 0;
let removeScreenListeners: (() => void) | null = null;

export function showCompactAuthWindow(options: CompactAuthWindowOptions): BrowserWindow {
  const targetWindow = liveWindow(options.anchorWindow ?? null);
  if (!targetWindow) {
    throw new Error("Compact auth mode requires an existing application window.");
  }

  compactAuthAnchorWindow = targetWindow;
  compactAuthOnCancel = options.onCancel ?? null;
  compactAuthOnRestore = options.onRestore ?? null;
  compactAuthOnRestoreLoadFailed = options.onRestoreLoadFailed ?? null;

  const existing = liveCompactAuthWindow();
  if (existing && existing !== targetWindow) closeCompactAuthWindow();

  const hadActiveSession = compactAuthSession?.window === targetWindow;
  const shouldTransition = !hadActiveSession || !targetWindow.isVisible();

  if (!hadActiveSession) {
    compactAuthSession = beginCompactAuthSession(targetWindow);
    ensureScreenListeners();
  }

  applyCompactAuthWindowState(targetWindow, options);
  targetWindow.showInactive();
  targetWindow.moveTop();
  if (shouldTransition) {
    beginCompactAuthTransition(targetWindow, options);
  } else {
    loadCompactAuthWindow(targetWindow, options);
    positionCompactAuthWindow(targetWindow);
  }
  return targetWindow;
}

export function closeCompactAuthWindow(): void {
  const session = compactAuthSession;
  const window = liveCompactAuthWindow();
  const onRestoreLoadFailed = compactAuthOnRestoreLoadFailed;
  compactAuthSession = null;
  compactAuthAnchorWindow = null;
  compactAuthOnRestore = null;
  compactAuthOnRestoreLoadFailed = null;
  compactAuthOnCancel = null;
  compactAuthLastHtml = null;
  removeScreenListeners?.();
  removeScreenListeners = null;
  if (!session || !window) return;

  compactAuthTransitionId += 1;
  compactAuthRestoring = true;
  try {
    restoreCompactAuthWindow(session, onRestoreLoadFailed);
  } finally {
    compactAuthRestoring = false;
  }
}

export function isCompactAuthWindowVisible(): boolean {
  const window = liveCompactAuthWindow();
  return Boolean(window && window.isVisible());
}

function liveWindow(window: BrowserWindow | null): BrowserWindow | null {
  return window && !window.isDestroyed() ? window : null;
}

function liveCompactAuthWindow(): BrowserWindow | null {
  return liveWindow(compactAuthSession?.window ?? null);
}

function beginCompactAuthSession(window: BrowserWindow): CompactAuthSession {
  const closeListener = (event: { preventDefault(): void }): void => {
    if (compactAuthRestoring) return;
    event.preventDefault();
    const onCancel = compactAuthOnCancel ?? compactAuthOnRestore;
    closeCompactAuthWindow();
    onCancel?.();
  };
  const navigateListener = (event: { preventDefault(): void }, url: string): void => {
    if (!handleCompactAuthNavigation(url)) return;
    event.preventDefault();
  };
  const closedListener = (): void => {
    if (compactAuthSession?.window === window) compactAuthSession = null;
    compactAuthAnchorWindow = null;
    compactAuthOnRestore = null;
    removeScreenListeners?.();
    removeScreenListeners = null;
  };
  const session = {
    closeListener,
    closedListener,
    navigateListener,
    restore: captureCompactAuthRestoreState(window),
    window,
  } satisfies CompactAuthSession;

  window.on("close", closeListener);
  window.webContents.on("will-navigate", navigateListener);
  window.once("closed", closedListener);
  return session;
}

function captureCompactAuthRestoreState(window: BrowserWindow): CompactAuthRestoreState {
  const maximumSize = tupleSize(window.getMaximumSize());
  const minimumSize = tupleSize(window.getMinimumSize());
  return {
    alwaysOnTop: window.isAlwaysOnTop(),
    backgroundColor: window.getBackgroundColor(),
    bounds: window.getNormalBounds(),
    fullScreen: window.isFullScreen(),
    fullScreenable: window.isFullScreenable(),
    maximizable: window.isMaximizable(),
    maximized: window.isMaximized(),
    maximumSize,
    menuBarAutoHide: window.isMenuBarAutoHide(),
    menuBarVisible: window.isMenuBarVisible(),
    minimizable: window.isMinimizable(),
    minimized: window.isMinimized(),
    minimumSize,
    movable: window.isMovable(),
    resizable: window.isResizable(),
    title: window.getTitle(),
    url: window.webContents.getURL() || null,
    visible: window.isVisible(),
  };
}

function tupleSize(size: readonly number[]): readonly [number, number] {
  return [Math.max(0, Math.round(size[0] ?? 0)), Math.max(0, Math.round(size[1] ?? 0))];
}

function applyCompactAuthWindowState(window: BrowserWindow, options: CompactAuthWindowOptions): void {
  if (window.isFullScreen()) window.setFullScreen(false);
  if (window.isMaximized()) window.unmaximize();
  if (window.isMinimized()) window.restore();

  window.setMinimumSize(1, 1);
  window.setMaximumSize(0, 0);
  window.setResizable(false);
  window.setMovable(true);
  window.setMinimizable(false);
  window.setMaximizable(false);
  window.setFullScreenable(false);
  window.setTitle(options.title ?? options.appName);
  window.setAutoHideMenuBar(true);
  window.setMenuBarVisibility(false);
  window.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "normal");
  if (process.platform === "darwin") {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setWindowButtonVisibility(false);
  }
}

function restoreCompactAuthWindow(
  session: CompactAuthSession,
  onRestoreLoadFailed: ((window: BrowserWindow) => void) | null,
): void {
  const { restore, window } = session;
  if (window.isDestroyed()) return;

  window.off("close", session.closeListener);
  window.off("closed", session.closedListener);
  window.webContents.off("will-navigate", session.navigateListener);
  if (process.platform === "darwin") {
    window.setWindowButtonVisibility(true);
    window.setVisibleOnAllWorkspaces(false);
  }
  window.setAlwaysOnTop(restore.alwaysOnTop);
  window.setBackgroundColor(restore.backgroundColor);
  window.setTitle(restore.title);
  window.setAutoHideMenuBar(restore.menuBarAutoHide);
  window.setMenuBarVisibility(restore.menuBarVisible);
  window.setBounds(restore.bounds, false);
  window.setMinimumSize(restore.minimumSize[0], restore.minimumSize[1]);
  window.setMaximumSize(restore.maximumSize[0], restore.maximumSize[1]);
  window.setResizable(restore.resizable);
  window.setMovable(restore.movable);
  window.setMinimizable(restore.minimizable);
  window.setMaximizable(restore.maximizable);
  window.setFullScreenable(restore.fullScreenable);
  if (restore.maximized) window.maximize();
  if (restore.fullScreen) window.setFullScreen(true);
  if (restore.url) {
    // The captured URL can be a client-side route with no file behind it
    // (the SPA fallback that serves such routes is a web-server concept that
    // file:// loads know nothing about). Silently swallowing that failure
    // left the window showing a dead blank document right after sign-in, so
    // hand the window back to the caller to reload its entry.
    void window.loadURL(restore.url).catch(() => {
      if (window.isDestroyed()) return;
      // A rejection can also mean "superseded" (ERR_ABORTED): if a new
      // compact-auth session reclaimed this window while the restore load was
      // in flight (auth status churn), reloading the entry would clobber it.
      if (compactAuthSession?.window === window) return;
      onRestoreLoadFailed?.(window);
    });
  }
  if (restore.minimized) {
    window.minimize();
  } else if (restore.visible) {
    window.show();
  } else {
    window.hide();
  }
}

function loadCompactAuthWindow(window: BrowserWindow, options: CompactAuthWindowOptions): void {
  const html = compactAuthWindowHtml({
    appName: options.appName,
    cancelUrl: CANCEL_URL,
    detail: options.detail,
    title: options.title,
  });
  if (html === compactAuthLastHtml) return;
  compactAuthLastHtml = html;
  void window.loadURL(compactAuthDataUrl(html));
}

function beginCompactAuthTransition(window: BrowserWindow, options: CompactAuthWindowOptions): void {
  const transitionId = compactAuthTransitionId + 1;
  compactAuthTransitionId = transitionId;
  void runCompactAuthTransition(window, options, transitionId);
}

async function runCompactAuthTransition(
  window: BrowserWindow,
  options: CompactAuthWindowOptions,
  transitionId: number,
): Promise<void> {
  window.setBackgroundColor("#000000");
  paintCurrentContentsBlack(window);
  compactAuthLastHtml = null;
  await loadCompactAuthBlackoutWindow(window, options.appName).catch(() => undefined);
  if (!compactAuthTransitionActive(window, transitionId)) return;

  await delay(COMPACT_AUTH_WINDOW_BLACKOUT_LEAD_MS);
  if (!compactAuthTransitionActive(window, transitionId)) return;

  const from = window.getBounds();
  const to = compactAuthBounds();
  if (systemPreferences.getAnimationSettings().prefersReducedMotion) {
    window.setBounds(to, false);
  } else {
    await animateCompactAuthBounds(window, from, to, transitionId);
  }
  if (!compactAuthTransitionActive(window, transitionId)) return;
  loadCompactAuthWindow(window, options);
}

function loadCompactAuthBlackoutWindow(window: BrowserWindow, appName: string): Promise<void> {
  return window.loadURL(compactAuthDataUrl(compactAuthWindowBlackoutHtml({ appName })));
}

function paintCurrentContentsBlack(window: BrowserWindow): void {
  void window.webContents.executeJavaScript(`
    (() => {
      document.documentElement.style.background = "#000";
      document.body.replaceChildren();
      document.body.style.cssText = "width:100%;height:100%;margin:0;overflow:hidden;background:#000;";
    })();
  `).catch(() => undefined);
}

function animateCompactAuthBounds(
  window: BrowserWindow,
  from: Rectangle,
  to: Rectangle,
  transitionId: number,
): Promise<void> {
  if (sameRectangle(from, to)) return Promise.resolve();
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      if (!compactAuthTransitionActive(window, transitionId)) {
        resolve();
        return;
      }
      const progress = Math.min(1, (Date.now() - startedAt) / COMPACT_AUTH_WINDOW_TRANSITION_MS);
      window.setBounds(compactAuthWindowTransitionBounds({ from, to, progress }), false);
      if (progress >= 1) {
        window.setBounds(to, false);
        resolve();
        return;
      }
      setTimeout(tick, COMPACT_AUTH_WINDOW_TRANSITION_FRAME_MS);
    };
    setTimeout(tick, COMPACT_AUTH_WINDOW_TRANSITION_FRAME_MS);
  });
}

function compactAuthTransitionActive(window: BrowserWindow, transitionId: number): boolean {
  return compactAuthTransitionId === transitionId && !window.isDestroyed() && compactAuthSession?.window === window;
}

function sameRectangle(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function compactAuthDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function handleCompactAuthNavigation(url: string): boolean {
  if (!url.startsWith(COMPACT_AUTH_WINDOW_EVENT_SCHEME)) return false;
  const onCancel = compactAuthOnCancel ?? compactAuthOnRestore;
  closeCompactAuthWindow();
  onCancel?.();
  return true;
}

function ensureScreenListeners(): void {
  if (removeScreenListeners) return;
  const reposition = (): void => {
    const window = liveCompactAuthWindow();
    if (window) positionCompactAuthWindow(window);
  };
  screen.on("display-added", reposition);
  screen.on("display-removed", reposition);
  screen.on("display-metrics-changed", reposition);
  removeScreenListeners = () => {
    screen.off("display-added", reposition);
    screen.off("display-removed", reposition);
    screen.off("display-metrics-changed", reposition);
  };
}

function positionCompactAuthWindow(window: BrowserWindow): void {
  window.setBounds(compactAuthBounds(), false);
}

function compactAuthBounds(): Rectangle {
  const display = compactAuthDisplay();
  return compactAuthWindowBounds({
    displayBounds: display.bounds,
    displayWorkArea: display.workArea,
    platform: process.platform,
  });
}

function compactAuthDisplay(): Display {
  const restoreBounds = compactAuthSession?.restore.bounds ?? null;
  const anchorBounds = restoreBounds ?? (
    compactAuthAnchorWindow && !compactAuthAnchorWindow.isDestroyed()
      ? compactAuthAnchorWindow.getBounds()
      : null
  );
  return anchorBounds
    ? screen.getDisplayMatching(anchorBounds)
    : screen.getPrimaryDisplay();
}
