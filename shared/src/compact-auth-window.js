export const COMPACT_AUTH_WINDOW_EVENT_SCHEME = "ambient-compact-auth:";
export const DEFAULT_COMPACT_AUTH_TITLE = "Sign into your Ambient Account";
export const DEFAULT_COMPACT_AUTH_WINDOW_WIDTH = 560;
export const DEFAULT_COMPACT_AUTH_WINDOW_HEIGHT = 128;
export const COMPACT_AUTH_WINDOW_BLACKOUT_LEAD_MS = 24;
export const COMPACT_AUTH_WINDOW_TRANSITION_FRAME_MS = 16;
export const COMPACT_AUTH_WINDOW_TRANSITION_MS = 180;

const DEFAULT_CANCEL_URL = `${COMPACT_AUTH_WINDOW_EVENT_SCHEME}//auth/cancel`;

export function compactAuthWindowBounds(input) {
  const platform = input.platform ?? "browser";
  const displayBounds = input.displayBounds;
  const displayWorkArea = input.displayWorkArea;
  const width = clampDimension(input.width, DEFAULT_COMPACT_AUTH_WINDOW_WIDTH, displayWorkArea.width);
  const height = clampDimension(
    input.height,
    DEFAULT_COMPACT_AUTH_WINDOW_HEIGHT,
    displayWorkArea.height,
  );
  const topInset = Number.isFinite(input.topInset) ? input.topInset : 8;
  const horizontalFrame = platform === "darwin" ? displayBounds : displayWorkArea;
  const verticalFrame = displayWorkArea;
  const x = Math.round(horizontalFrame.x + (horizontalFrame.width - width) / 2);
  const y = Math.round(verticalFrame.y + topInset);

  return { x, y, width, height };
}

export function compactAuthWindowBlackoutHtml(input = {}) {
  const appName = escapeHtml(input.appName ?? "Ambient");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${appName}</title>
  <style>
    html,
    body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: #000;
      user-select: none;
    }

    body {
      -webkit-app-region: drag;
    }
  </style>
</head>
<body aria-label="${appName} sign-in transition"></body>
</html>`;
}

export function compactAuthWindowTransitionBounds(input) {
  const progress = compactAuthWindowTransitionProgress(input.progress);
  return {
    x: interpolateDimension(input.from.x, input.to.x, progress),
    y: interpolateDimension(input.from.y, input.to.y, progress),
    width: interpolateDimension(input.from.width, input.to.width, progress),
    height: interpolateDimension(input.from.height, input.to.height, progress),
  };
}

export function compactAuthWindowTransitionProgress(progress) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 1));
  return 1 - Math.pow(1 - clamped, 3);
}

export function leaveCompactAuthFullScreen(window, platform = "browser") {
  if (!window.isFullScreen()) return Promise.resolve();
  if (platform !== "darwin") {
    window.setFullScreen(false);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.off("leave-full-screen", finish);
      window.off("closed", finish);
      resolve();
    };
    window.once("leave-full-screen", finish);
    window.once("closed", finish);
    window.setFullScreen(false);
  });
}

export function leaveCompactAuthMaximized(window, platform = "browser") {
  if (!window.isMaximized()) return Promise.resolve();
  if (platform !== "darwin") {
    window.unmaximize();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.off("unmaximize", finish);
      window.off("closed", finish);
      resolve();
    };
    window.once("unmaximize", finish);
    window.once("closed", finish);
    window.unmaximize();
  });
}

export function compactAuthWindowHtml(input = {}) {
  const title = escapeHtml(input.title ?? DEFAULT_COMPACT_AUTH_TITLE);
  const detail = escapeHtml(input.detail ?? "");
  const appName = escapeHtml(input.appName ?? "Ambient");
  const cancelLabel = escapeHtml(input.cancelLabel ?? "Cancel");
  const cancelUrl = JSON.stringify(input.cancelUrl ?? DEFAULT_CANCEL_URL);
  const detailMarkup = detail
    ? `<div class="detail">${detail}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${appName}</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      text-rendering: geometricPrecision;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: #000;
      user-select: none;
    }

    body {
      display: grid;
      place-items: center;
      padding: 16px 28px 18px;
      color: #f8f8f8;
      background: #000;
      border: 0;
      -webkit-app-region: drag;
    }

    .auth-shell {
      display: grid;
      width: 100%;
      height: 100%;
      place-items: center;
    }

    .content {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-width: 0;
      width: 100%;
      text-align: center;
      line-height: 1.2;
    }

    .title,
    .detail {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .title {
      font-size: 15px;
      font-weight: 650;
      letter-spacing: 0;
    }

    .detail {
      margin-top: 4px;
      color: rgba(255, 255, 255, 0.68);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0;
    }

    .actions {
      display: flex;
      justify-content: center;
      gap: 8px;
      margin-top: 12px;
      -webkit-app-region: no-drag;
    }

    .action {
      height: 24px;
      padding: 0 12px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      color: rgba(255, 255, 255, 0.62);
      background: rgba(255, 255, 255, 0.05);
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0;
      line-height: 22px;
      cursor: default;
      transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
    }

    .action:hover,
    .action:focus-visible {
      color: rgba(255, 255, 255, 0.9);
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.18);
      outline: none;
    }
  </style>
</head>
<body>
  <section class="auth-shell" aria-label="${appName} sign-in">
    <div class="content">
      <div class="title">${title}</div>
      ${detailMarkup}
      <div class="actions" aria-label="Sign-in actions">
        <button class="action" type="button" data-action="cancel">${cancelLabel}</button>
      </div>
    </div>
  </section>
  <script>
    const compactAuthActions = {
      cancel: ${cancelUrl},
    };
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const action = button.getAttribute("data-action");
        const url = compactAuthActions[action];
        if (url) window.location.href = url;
      });
    });
  </script>
</body>
</html>`;
}

function clampDimension(value, fallback, available) {
  const numeric = Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.min(Math.round(numeric), Math.max(1, Math.round(available))));
}

function interpolateDimension(from, to, progress) {
  return Math.round(from + (to - from) * progress);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
