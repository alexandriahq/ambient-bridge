import { describe, expect, it } from "vitest";
import {
  COMPACT_AUTH_WINDOW_BLACKOUT_LEAD_MS,
  COMPACT_AUTH_WINDOW_TRANSITION_MS,
  DEFAULT_COMPACT_AUTH_WINDOW_HEIGHT,
  DEFAULT_COMPACT_AUTH_WINDOW_WIDTH,
  compactAuthWindowBlackoutHtml,
  compactAuthWindowBounds,
  compactAuthWindowHtml,
  compactAuthWindowTransitionBounds,
  compactAuthWindowTransitionProgress,
} from "@ambient/shared/compact-auth-window";

describe("compact auth window", () => {
  it("centers the macOS floating window below the menu bar", () => {
    expect(
      compactAuthWindowBounds({
        displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
        displayWorkArea: { x: 0, y: 24, width: 1440, height: 876 },
        platform: "darwin",
      }),
    ).toEqual({
      height: DEFAULT_COMPACT_AUTH_WINDOW_HEIGHT,
      width: DEFAULT_COMPACT_AUTH_WINDOW_WIDTH,
      x: 440,
      y: 32,
    });
  });

  it("uses the work area for Windows-like desktops", () => {
    expect(
      compactAuthWindowBounds({
        displayBounds: { x: 0, y: 0, width: 1200, height: 800 },
        displayWorkArea: { x: 0, y: 32, width: 1200, height: 720 },
        platform: "win32",
      }),
    ).toEqual({
      height: DEFAULT_COMPACT_AUTH_WINDOW_HEIGHT,
      width: DEFAULT_COMPACT_AUTH_WINDOW_WIDTH,
      x: 320,
      y: 40,
    });
  });

  it("escapes display text in the rendered shell", () => {
    const html = compactAuthWindowHtml({
      appName: "Ambient <Bridge>",
      detail: "Use \"browser\"",
      title: "Sign <in>",
    });

    expect(html).toContain("Ambient &lt;Bridge&gt;");
    expect(html).toContain("Use &quot;browser&quot;");
    expect(html).toContain("Sign &lt;in&gt;");
    expect(html).not.toContain("Sign <in>");
  });

  it("renders as a pitch-black native window body without a fake island", () => {
    const html = compactAuthWindowHtml();

    expect(html).toContain("background: #000;");
    expect(html).toContain('class="auth-shell"');
    expect(html).toContain('data-action="cancel"');
    expect(html).toContain("-webkit-app-region: no-drag;");
    expect(html).not.toContain("island-enter");
    expect(html).not.toContain("border-radius: 0 0");
    expect(html).not.toContain("data-close");
    expect(html).not.toContain('data-action="retry"');
    expect(html).not.toContain(">Retry<");
    expect(html).not.toContain("#ff5f57");
  });

  it("renders a plain black staging document before the compact controls appear", () => {
    const html = compactAuthWindowBlackoutHtml({ appName: "Ambient <Bridge>" });

    expect(html).toContain("Ambient &lt;Bridge&gt;");
    expect(html).toContain("background: #000;");
    expect(html).toContain("sign-in transition");
    expect(html).not.toContain("auth-shell");
    expect(html).not.toContain("data-action");
  });

  it("uses one eased progress value for position and size during transition", () => {
    const from = { x: 120, y: 80, width: 1040, height: 720 };
    const to = { x: 440, y: 32, width: DEFAULT_COMPACT_AUTH_WINDOW_WIDTH, height: DEFAULT_COMPACT_AUTH_WINDOW_HEIGHT };
    const progress = 0.5;
    const bounds = compactAuthWindowTransitionBounds({ from, to, progress });
    const easedProgress = compactAuthWindowTransitionProgress(progress);

    expect(bounds).toEqual({
      x: Math.round(from.x + (to.x - from.x) * easedProgress),
      y: Math.round(from.y + (to.y - from.y) * easedProgress),
      width: Math.round(from.width + (to.width - from.width) * easedProgress),
      height: Math.round(from.height + (to.height - from.height) * easedProgress),
    });
    expect(COMPACT_AUTH_WINDOW_BLACKOUT_LEAD_MS).toBeLessThan(40);
    expect(COMPACT_AUTH_WINDOW_TRANSITION_MS).toBeGreaterThanOrEqual(150);
    expect(COMPACT_AUTH_WINDOW_TRANSITION_MS).toBeLessThanOrEqual(300);
  });
});
