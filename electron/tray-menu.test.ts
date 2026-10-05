import { describe, expect, test, vi } from "vitest";
import { buildBridgeTrayMenuTemplate } from "./tray-menu.js";

describe("buildBridgeTrayMenuTemplate", () => {
  test("matches Ambient app tray shape: Open, separator, Quit — no checkbox column", () => {
    const handlers = {
      onQuit: vi.fn(),
      onShow: vi.fn(),
    };
    const template = buildBridgeTrayMenuTemplate({
      appName: "Ambient Bridge Local",
      handlers,
    });

    expect(template.map((item) => ({ label: item.label, type: item.type }))).toEqual([
      { label: "Open Ambient Bridge Local", type: undefined },
      { label: undefined, type: "separator" },
      { label: "Quit", type: undefined },
    ]);
    expect(template.some((item) => item.type === "checkbox")).toBe(false);

    template[0]?.click?.(template[0] as never, undefined, {} as never);
    template[2]?.click?.(template[2] as never, undefined, {} as never);
    expect(handlers.onShow).toHaveBeenCalledOnce();
    expect(handlers.onQuit).toHaveBeenCalledOnce();
  });
});
