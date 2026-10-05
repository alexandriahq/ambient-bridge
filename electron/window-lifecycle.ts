import { isAmbientSilentLaunch } from "@ambient/shared/silent-mode";

export const BRIDGE_BACKGROUND_LAUNCH_ARG = "--ambient-bridge-background";
export const BRIDGE_SHOW_LAUNCH_ARG = "--ambient-bridge-show";

const BACKGROUND_LAUNCH_ARGS = new Set([
  BRIDGE_BACKGROUND_LAUNCH_ARG,
  "--ambient-bridge-headless",
  "--background",
  "--headless",
  "--hidden",
]);

const SHOW_LAUNCH_ARGS = new Set([
  BRIDGE_SHOW_LAUNCH_ARG,
  "--ambient-bridge-open",
  "--show",
]);

type BridgeEnvironment = Record<string, string | undefined>;

type BridgeLoginItemSettings = {
  readonly wasOpenedAsHidden?: boolean;
  readonly wasOpenedAtLogin?: boolean;
};

export type BridgeLaunchDecisionReason =
  | "background_arg"
  | "default_hidden"
  | "env_background"
  | "explicit_arg"
  | "login_item"
  | "silent";

export type BridgeLaunchDecision = {
  readonly mode: "background" | "show";
  readonly reason: BridgeLaunchDecisionReason;
};

export type BridgeLifecycleWindowState = "not_created" | "hidden" | "visible";

export type BridgeLifecycleState = {
  readonly mainWindow: BridgeLifecycleWindowState;
  readonly quitting: boolean;
  readonly services: "background_running";
};

export type BridgeWindowCloseEvent = {
  preventDefault(): void;
};

export type BridgeKeyboardEvent = {
  preventDefault(): void;
};

export type BridgeKeyboardInput = {
  readonly alt?: boolean;
  readonly code?: string;
  readonly control?: boolean;
  readonly key?: string;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly type?: string;
};

export type BridgeWindowLike = {
  destroy?(): void;
  focus(): void;
  hide(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible?(): boolean;
  on(event: "close", listener: (event: BridgeWindowCloseEvent) => void): unknown;
  on(event: "closed", listener: () => void): unknown;
  restore(): void;
  setSkipTaskbar?(skip: boolean): void;
  show(): void;
  webContents?: {
    on(event: "before-input-event", listener: (event: BridgeKeyboardEvent, input: BridgeKeyboardInput) => void): unknown;
  };
};

export type BridgeWindowLifecycleControllerOptions = {
  readonly activateApp?: () => void;
  readonly createWindow: () => Promise<BridgeWindowLike>;
  /** Resign app activation after hiding (macOS `app.hide()`): an accessory app
   * that stays active keeps owning the menu bar with no visible window. */
  readonly deactivateApp?: () => void;
  readonly destroyTray?: () => void;
  readonly onStateChange?: (state: BridgeLifecycleState) => void;
  readonly platform: NodeJS.Platform;
  readonly quitApp?: () => void;
};

export function resolveBridgeLaunchDecision(input: {
  readonly argv: readonly string[];
  readonly env?: BridgeEnvironment;
  readonly loginItemSettings?: BridgeLoginItemSettings;
}): BridgeLaunchDecision {
  // Silent wins over every reveal request: managed deployments must never
  // surface Bridge UI, even when a wrapper passes a show arg.
  if (isAmbientSilentLaunch(input)) {
    return { mode: "background", reason: "silent" };
  }

  const args = normalizedArgs(input.argv);
  if (args.some((arg) => SHOW_LAUNCH_ARGS.has(arg))) {
    return { mode: "show", reason: "explicit_arg" };
  }

  // Omarchy / Linux helpers use env to reveal without threading Electron argv
  // through pnpm/dev wrappers.
  if (isTruthy(input.env?.AMBIENT_BRIDGE_SHOW)) {
    return { mode: "show", reason: "explicit_arg" };
  }

  if (isTruthy(input.env?.AMBIENT_BRIDGE_START_HIDDEN) || isTruthy(input.env?.AMBIENT_BRIDGE_BACKGROUND)) {
    return { mode: "background", reason: "env_background" };
  }

  if (args.some((arg) => BACKGROUND_LAUNCH_ARGS.has(arg))) {
    return { mode: "background", reason: "background_arg" };
  }

  if (input.loginItemSettings?.wasOpenedAtLogin || input.loginItemSettings?.wasOpenedAsHidden) {
    return { mode: "background", reason: "login_item" };
  }

  // Cold start (Finder / Start menu / `pnpm ambient:dev:bridge`) stays in the tray /
  // menu bar. Reveal via tray click, activate, or `--ambient-bridge-show`.
  return { mode: "background", reason: "default_hidden" };
}

export function shouldOpenMainWindowOnLaunch(decision: BridgeLaunchDecision): boolean {
  return decision.mode === "show";
}

/** Bridge never uses Chromium GPU. Open uses software compositing. */
export function shouldDisableHardwareAcceleration(): boolean {
  return true;
}

/** True when a launch asked to stay headless (env/arg/login), not merely the default. */
export function isExplicitBackgroundLaunch(decision: BridgeLaunchDecision): boolean {
  return (
    decision.reason === "background_arg"
    || decision.reason === "env_background"
    || decision.reason === "login_item"
    || decision.reason === "silent"
  );
}

export function bridgeBackgroundLoginItemArgs(existingArgs: readonly string[] = []): string[] {
  const args = existingArgs.filter((arg) => {
    const normalized = normalizeArg(arg);
    return !BACKGROUND_LAUNCH_ARGS.has(normalized) && !SHOW_LAUNCH_ARGS.has(normalized);
  });
  return [...args, BRIDGE_BACKGROUND_LAUNCH_ARG];
}

export function bridgeLoginItemSettingsOptions(input: {
  readonly execPath?: string;
  readonly platform: NodeJS.Platform;
}): { readonly args?: string[]; readonly path?: string } | undefined {
  if (input.platform !== "win32") return undefined;
  return {
    args: bridgeBackgroundLoginItemArgs(),
    ...(input.execPath ? { path: input.execPath } : {}),
  };
}

export function macBridgeActivationPolicy(state: "background" | "visible"): "accessory" | "regular" {
  return state === "visible" ? "regular" : "accessory";
}

export function shouldShowMacDock(platform: NodeJS.Platform, state: "background" | "visible"): boolean {
  return platform === "darwin" && state === "visible";
}

export function windowsSkipTaskbarForWindowState(
  platform: NodeJS.Platform,
  state: BridgeLifecycleWindowState,
): boolean | undefined {
  if (platform !== "win32") return undefined;
  return state !== "visible";
}

export function isCloseWindowAccelerator(input: BridgeKeyboardInput, platform: NodeJS.Platform): boolean {
  if (!isKeyDown(input) || input.alt || input.shift) return false;
  if (normalizedKey(input) !== "w") return false;
  return platform === "darwin" ? Boolean(input.meta) : Boolean(input.control);
}

export function isQuitAccelerator(input: BridgeKeyboardInput, platform: NodeJS.Platform): boolean {
  if (!isKeyDown(input) || input.alt || input.shift) return false;
  if (normalizedKey(input) !== "q") return false;
  return platform === "darwin" ? Boolean(input.meta) : Boolean(input.control);
}

export class BridgeWindowLifecycleController {
  private mainWindow: BridgeWindowLike | undefined;
  private mainWindowState: BridgeLifecycleWindowState = "not_created";
  private createWindowPromise: Promise<BridgeWindowLike> | undefined;
  private quitting = false;

  constructor(private readonly options: BridgeWindowLifecycleControllerOptions) {}

  get state(): BridgeLifecycleState {
    return this.snapshot();
  }

  get isQuitting(): boolean {
    return this.quitting;
  }

  liveWindow(): BridgeWindowLike | null {
    return liveWindow(this.mainWindow);
  }

  async showMainWindow(): Promise<BridgeWindowLike> {
    const window = await this.ensureMainWindow();
    setWindowsTaskbarVisibility(this.options.platform, window, "visible");
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    this.options.activateApp?.();
    this.setMainWindowState("visible");
    return window;
  }

  hideMainWindow(): void {
    const window = this.liveWindow();
    if (!window) {
      this.setMainWindowState("not_created");
      return;
    }
    // Destroy the BrowserWindow so tray-only Bridge does not keep a warm
    // Chromium renderer resident. showMainWindow() recreates it lazily.
    setWindowsTaskbarVisibility(this.options.platform, window, "hidden");
    this.options.deactivateApp?.();
    if (typeof window.destroy === "function") {
      window.destroy();
      // `closed` clears the handle; keep state honest if destroy is sync.
      if (this.liveWindow() === null) this.setMainWindowState("not_created");
      return;
    }
    window.hide();
    this.setMainWindowState("hidden");
  }

  prepareForQuit(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.options.destroyTray?.();
    this.emitStateChange();
  }

  requestQuit(): void {
    this.prepareForQuit();
    this.options.quitApp?.();
  }

  private async ensureMainWindow(): Promise<BridgeWindowLike> {
    const existing = this.liveWindow();
    if (existing) return existing;
    // createWindow awaits renderer loadURL in Electron; tray click + double-click,
    // second-instance reveal, and auth completion can overlap that await in dev
    // and otherwise spawn two main windows. Coalesce creators onto one promise.
    if (!this.createWindowPromise) {
      this.createWindowPromise = this.createMainWindow().finally(() => {
        this.createWindowPromise = undefined;
      });
    }
    return this.createWindowPromise;
  }

  private async createMainWindow(): Promise<BridgeWindowLike> {
    const existing = this.liveWindow();
    if (existing) return existing;

    const window = await this.options.createWindow();
    this.mainWindow = window;
    this.attachWindowHandlers(window);
    const initialState = window.isVisible?.() ? "visible" : "hidden";
    setWindowsTaskbarVisibility(this.options.platform, window, initialState);
    this.setMainWindowState(initialState);
    return window;
  }

  private attachWindowHandlers(window: BridgeWindowLike): void {
    window.on("close", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.hideMainWindow();
    });
    window.on("closed", () => {
      if (this.mainWindow === window) {
        this.mainWindow = undefined;
        this.setMainWindowState("not_created");
      }
    });
    window.webContents?.on("before-input-event", (event, input) => {
      if (isCloseWindowAccelerator(input, this.options.platform)) {
        event.preventDefault();
        this.hideMainWindow();
        return;
      }
      if (isQuitAccelerator(input, this.options.platform)) {
        event.preventDefault();
        this.requestQuit();
      }
    });
  }

  private setMainWindowState(state: BridgeLifecycleWindowState): void {
    if (this.mainWindowState === state) return;
    this.mainWindowState = state;
    this.emitStateChange();
  }

  private snapshot(): BridgeLifecycleState {
    return {
      mainWindow: this.mainWindowState,
      quitting: this.quitting,
      services: "background_running",
    };
  }

  private emitStateChange(): void {
    this.options.onStateChange?.(this.snapshot());
  }
}

function setWindowsTaskbarVisibility(
  platform: NodeJS.Platform,
  window: BridgeWindowLike,
  state: BridgeLifecycleWindowState,
): void {
  const skipTaskbar = windowsSkipTaskbarForWindowState(platform, state);
  if (skipTaskbar === undefined) return;
  window.setSkipTaskbar?.(skipTaskbar);
}

function normalizedArgs(argv: readonly string[]): string[] {
  return argv.map(normalizeArg).filter((arg): arg is string => Boolean(arg));
}

function normalizeArg(arg: string): string {
  return arg.split("=", 1)[0]?.trim() ?? "";
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function liveWindow(window: BridgeWindowLike | undefined): BridgeWindowLike | null {
  return window && !window.isDestroyed() ? window : null;
}

function isKeyDown(input: BridgeKeyboardInput): boolean {
  return !input.type || input.type === "keyDown";
}

function normalizedKey(input: BridgeKeyboardInput): string {
  const key = input.key?.toLowerCase();
  if (key) return key;
  const code = input.code?.toLowerCase();
  if (code?.startsWith("key")) return code.slice(3);
  return code ?? "";
}
