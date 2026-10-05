import type { MenuItemConstructorOptions } from "electron";

export type BridgeTrayMenuHandlers = {
  readonly onQuit: () => void;
  readonly onShow: () => void;
};

/**
 * Build the tray/menu-bar context menu.
 *
 * Matches Ambient app tray shape (Open + Quit only). Launch-at-login for
 * the product lives on Ambient Settings → Startup, which auto-starts Bridge.
 */
export function buildBridgeTrayMenuTemplate(options: {
  readonly appName: string;
  readonly handlers: BridgeTrayMenuHandlers;
}): MenuItemConstructorOptions[] {
  return [
    { label: `Open ${options.appName}`, click: options.handlers.onShow },
    { type: "separator" },
    { label: "Quit", click: options.handlers.onQuit },
  ];
}
