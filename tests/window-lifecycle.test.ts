import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_BACKGROUND_LAUNCH_ARG,
  BRIDGE_SHOW_LAUNCH_ARG,
  BridgeWindowLifecycleController,
  bridgeBackgroundLoginItemArgs,
  bridgeLoginItemSettings,
  bridgeLoginItemSettingsOptions,
  isCloseWindowAccelerator,
  isQuitAccelerator,
  macBridgeActivationPolicy,
  resolveBridgeLaunchDecision,
  shouldHideMacDock,
  shouldOpenMainWindowOnLaunch,
  windowsSkipTaskbarForWindowState,
  type BridgeKeyboardEvent,
  type BridgeKeyboardInput,
  type BridgeWindowCloseEvent,
  type BridgeWindowLike,
} from "../electron/window-lifecycle.js";

describe("Bridge background launch policy", () => {
  it("starts headless for login-item launches", () => {
    const decision = resolveBridgeLaunchDecision({
      argv: ["Ambient Bridge"],
      loginItemSettings: { wasOpenedAtLogin: true },
    });

    expect(decision).toEqual({ mode: "background", reason: "login_item" });
    expect(shouldOpenMainWindowOnLaunch(decision)).toBe(false);
  });

  it("starts headless for explicit background flags", () => {
    const decision = resolveBridgeLaunchDecision({ argv: ["Ambient Bridge", BRIDGE_BACKGROUND_LAUNCH_ARG] });

    expect(decision).toEqual({ mode: "background", reason: "background_arg" });
    expect(shouldOpenMainWindowOnLaunch(decision)).toBe(false);
  });

  it("shows UI for explicit launches, including second-instance style argv", () => {
    const firstLaunch = resolveBridgeLaunchDecision({ argv: ["Ambient Bridge"] });
    const secondLaunch = resolveBridgeLaunchDecision({ argv: ["Ambient Bridge", "--launched-from-start-menu"] });

    expect(firstLaunch).toEqual({ mode: "show", reason: "explicit_launch" });
    expect(shouldOpenMainWindowOnLaunch(secondLaunch)).toBe(true);
    expect(resolveBridgeLaunchDecision({
      argv: ["Ambient Bridge", BRIDGE_SHOW_LAUNCH_ARG, BRIDGE_BACKGROUND_LAUNCH_ARG],
      loginItemSettings: { wasOpenedAtLogin: true },
    })).toEqual({ mode: "show", reason: "explicit_arg" });
  });

  it("uses accessory/no-Dock presentation on macOS", () => {
    expect(macBridgeActivationPolicy()).toBe("accessory");
    expect(shouldHideMacDock("darwin")).toBe(true);
    expect(shouldHideMacDock("win32")).toBe(false);
  });

  it("configures login items to relaunch Bridge in the background", () => {
    expect(bridgeBackgroundLoginItemArgs(["--foo", BRIDGE_SHOW_LAUNCH_ARG])).toEqual([
      "--foo",
      BRIDGE_BACKGROUND_LAUNCH_ARG,
    ]);
    expect(bridgeLoginItemSettings({ openAtLogin: true, platform: "darwin" })).toEqual({
      openAsHidden: true,
      openAtLogin: true,
    });
    expect(bridgeLoginItemSettings({ execPath: "C:/Ambient Bridge.exe", openAtLogin: true, platform: "win32" }))
      .toEqual({
        args: [BRIDGE_BACKGROUND_LAUNCH_ARG],
        openAtLogin: true,
        path: "C:/Ambient Bridge.exe",
      });
    expect(bridgeLoginItemSettingsOptions({ execPath: "C:/Ambient Bridge.exe", platform: "win32" }))
      .toEqual({ args: [BRIDGE_BACKGROUND_LAUNCH_ARG], path: "C:/Ambient Bridge.exe" });
    expect(bridgeLoginItemSettingsOptions({ platform: "darwin" })).toBeUndefined();
  });

  it("keeps Windows taskbar skipped while hidden but not while visible", () => {
    expect(windowsSkipTaskbarForWindowState("win32", "not_created")).toBe(true);
    expect(windowsSkipTaskbarForWindowState("win32", "hidden")).toBe(true);
    expect(windowsSkipTaskbarForWindowState("win32", "visible")).toBe(false);
    expect(windowsSkipTaskbarForWindowState("darwin", "hidden")).toBeUndefined();
  });
});

describe("Bridge window lifecycle controller", () => {
  it("creates the main window lazily and hides instead of quitting on close", async () => {
    const window = new FakeWindow();
    const controller = new BridgeWindowLifecycleController({
      createWindow: vi.fn().mockResolvedValue(window),
      platform: "darwin",
    });

    expect(controller.state.mainWindow).toBe("not_created");
    await controller.showMainWindow();
    expect(window.showCalls).toBe(1);
    expect(controller.state.mainWindow).toBe("visible");

    const event = preventableEvent();
    window.emitClose(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.hideCalls).toBe(1);
    expect(controller.state.mainWindow).toBe("hidden");
    expect(controller.isQuitting).toBe(false);
  });

  it("routes Ctrl/Cmd+W to hide and Ctrl/Cmd+Q to explicit quit", async () => {
    const window = new FakeWindow();
    const quitApp = vi.fn();
    const destroyTray = vi.fn();
    const controller = new BridgeWindowLifecycleController({
      createWindow: vi.fn().mockResolvedValue(window),
      destroyTray,
      platform: "win32",
      quitApp,
    });

    await controller.showMainWindow();
    expect(window.skipTaskbarValues).toEqual([true, false]);

    const closeEvent = preventableKeyboardEvent();
    window.emitBeforeInput(closeEvent, { control: true, key: "w", type: "keyDown" });
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(window.hideCalls).toBe(1);
    expect(window.skipTaskbarValues).toEqual([true, false, true]);

    const quitEvent = preventableKeyboardEvent();
    window.emitBeforeInput(quitEvent, { control: true, key: "q", type: "keyDown" });
    expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
    expect(controller.isQuitting).toBe(true);
    expect(destroyTray).toHaveBeenCalledOnce();
    expect(quitApp).toHaveBeenCalledOnce();
  });

  it("resigns app activation when hiding so the menu bar returns to the previous app", async () => {
    const window = new FakeWindow();
    const deactivateApp = vi.fn();
    const controller = new BridgeWindowLifecycleController({
      createWindow: vi.fn().mockResolvedValue(window),
      deactivateApp,
      platform: "darwin",
    });

    await controller.showMainWindow();
    expect(deactivateApp).not.toHaveBeenCalled();

    controller.hideMainWindow();
    expect(window.hideCalls).toBe(1);
    expect(deactivateApp).toHaveBeenCalledOnce();
  });

  it("allows close to proceed during explicit quit", async () => {
    const window = new FakeWindow();
    const controller = new BridgeWindowLifecycleController({
      createWindow: vi.fn().mockResolvedValue(window),
      platform: "win32",
    });

    await controller.showMainWindow();
    controller.prepareForQuit();
    const event = preventableEvent();
    window.emitClose(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(window.hideCalls).toBe(0);
    expect(controller.state.quitting).toBe(true);
  });

  it("tracks auth-window visibility separately from the main window", async () => {
    const window = new FakeWindow();
    const states: string[] = [];
    const controller = new BridgeWindowLifecycleController({
      createWindow: vi.fn().mockResolvedValue(window),
      onStateChange: (state) => states.push(`${state.mainWindow}:${state.authWindow}:${state.quitting}`),
      platform: "darwin",
    });

    await controller.showMainWindow();
    controller.markAuthWindowVisible();
    controller.hideMainWindow();
    controller.markAuthWindowHidden();

    expect(controller.state).toMatchObject({ authWindow: "hidden", mainWindow: "hidden", quitting: false });
    expect(states).toContain("visible:visible:false");
    expect(states.at(-1)).toBe("hidden:hidden:false");
  });

  it("recreates the main window after it is destroyed", async () => {
    const first = new FakeWindow();
    const second = new FakeWindow();
    const createWindow = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const controller = new BridgeWindowLifecycleController({ createWindow, platform: "darwin" });

    await expect(controller.showMainWindow()).resolves.toBe(first);
    first.emitClosed();
    expect(controller.state.mainWindow).toBe("not_created");

    await expect(controller.showMainWindow()).resolves.toBe(second);
    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(controller.state.mainWindow).toBe("visible");
  });

  it("recognizes platform close and quit accelerators", () => {
    expect(isCloseWindowAccelerator({ key: "w", meta: true, type: "keyDown" }, "darwin")).toBe(true);
    expect(isCloseWindowAccelerator({ key: "w", control: true, type: "keyDown" }, "win32")).toBe(true);
    expect(isCloseWindowAccelerator({ key: "w", control: true, type: "keyUp" }, "win32")).toBe(false);
    expect(isQuitAccelerator({ key: "q", meta: true, type: "keyDown" }, "darwin")).toBe(true);
    expect(isQuitAccelerator({ key: "q", control: true, type: "keyDown" }, "linux")).toBe(true);
  });
});

class FakeWindow implements BridgeWindowLike {
  readonly skipTaskbarValues: boolean[] = [];
  readonly webContents = {
    on: (event: "before-input-event", listener: (event: BridgeKeyboardEvent, input: BridgeKeyboardInput) => void) => {
      this.beforeInputListeners.push(listener);
    },
  };

  hideCalls = 0;
  showCalls = 0;
  private beforeInputListeners: Array<(event: BridgeKeyboardEvent, input: BridgeKeyboardInput) => void> = [];
  private closeListeners: Array<(event: BridgeWindowCloseEvent) => void> = [];
  private closedListeners: Array<() => void> = [];
  private destroyed = false;
  private minimized = false;
  private visible = false;

  focus(): void {}

  hide(): void {
    this.hideCalls += 1;
    this.visible = false;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isVisible(): boolean {
    return this.visible;
  }

  on(event: "close", listener: (event: BridgeWindowCloseEvent) => void): unknown;
  on(event: "closed", listener: () => void): unknown;
  on(event: "close" | "closed", listener: ((event: BridgeWindowCloseEvent) => void) | (() => void)): unknown {
    if (event === "close") {
      this.closeListeners.push(listener as (event: BridgeWindowCloseEvent) => void);
    } else {
      this.closedListeners.push(listener as () => void);
    }
  }

  restore(): void {
    this.minimized = false;
  }

  setSkipTaskbar(skip: boolean): void {
    this.skipTaskbarValues.push(skip);
  }

  show(): void {
    this.showCalls += 1;
    this.visible = true;
  }

  emitClose(event: BridgeWindowCloseEvent): void {
    for (const listener of this.closeListeners) listener(event);
  }

  emitClosed(): void {
    this.destroyed = true;
    for (const listener of this.closedListeners) listener();
  }

  emitBeforeInput(event: BridgeKeyboardEvent, input: BridgeKeyboardInput): void {
    for (const listener of this.beforeInputListeners) listener(event, input);
  }
}

function preventableEvent(): BridgeWindowCloseEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return { preventDefault: vi.fn() };
}

function preventableKeyboardEvent(): BridgeKeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return { preventDefault: vi.fn() };
}
