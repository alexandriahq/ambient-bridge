/**
 * Pure HTML + URL-protocol pieces of the crash-report consent dialog, shared by
 * the Ambient app and Bridge. Each app hosts this in its own tiny BrowserWindow
 * (loaded via a data: URL) and listens for navigations to the event scheme.
 *
 * Plain ESM JavaScript (types in consent-dialog.d.ts); see crash-ring.js for why.
 */

export const CRASH_CONSENT_DECLINED = Object.freeze({ send: false, includeLogs: false, note: "" });

export function parseCrashConsentUrl(url, eventScheme, noteMaxLength) {
  if (!url.startsWith(eventScheme)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "submit" && parsed.pathname.replace(/\//g, "") !== "submit") {
      return CRASH_CONSENT_DECLINED;
    }
    const send = parsed.searchParams.get("send") === "1";
    const includeLogs = parsed.searchParams.get("logs") === "1";
    const note = (parsed.searchParams.get("note") ?? "").slice(0, noteMaxLength);
    return { send, includeLogs, note };
  } catch {
    return CRASH_CONSENT_DECLINED;
  }
}

export function renderCrashConsentHtml(content) {
  const bg = content.dark ? "#1c1c1e" : "#ffffff";
  const fg = content.dark ? "#f2f2f7" : "#1c1c1e";
  const subtle = content.dark ? "#9a9aa0" : "#6c6c70";
  const border = content.dark ? "#3a3a3c" : "#d1d1d6";
  const field = content.dark ? "#2c2c2e" : "#f2f2f7";
  const accent = "#0a84ff";
  return `<!doctype html><html><head><meta charset="utf-8" />
<style>
  :root { color-scheme: ${content.dark ? "dark" : "light"}; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
         background: ${bg}; color: ${fg}; font-size: 13px; }
  h1 { font-size: 16px; margin: 0 0 6px; }
  p.lead { margin: 0 0 12px; color: ${subtle}; line-height: 1.4; }
  .err { background: ${field}; border: 1px solid ${border}; border-radius: 8px; padding: 8px 10px;
         font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: ${fg};
         white-space: pre-wrap; word-break: break-word; max-height: 72px; overflow: auto; margin: 0 0 14px; }
  .meta { color: ${subtle}; font-size: 11px; margin: 0 0 14px; }
  label.note { display: block; margin: 0 0 6px; color: ${subtle}; }
  textarea { width: 100%; height: 86px; resize: none; border-radius: 8px; border: 1px solid ${border};
             background: ${field}; color: ${fg}; padding: 8px 10px; font: inherit; }
  .row { display: flex; align-items: center; gap: 8px; margin: 12px 0 18px; color: ${subtle}; }
  .actions { display: flex; justify-content: flex-end; gap: 10px; }
  button { font: inherit; font-weight: 590; padding: 8px 16px; border-radius: 8px; border: 1px solid ${border};
           background: ${field}; color: ${fg}; cursor: pointer; }
  button.primary { background: ${accent}; border-color: ${accent}; color: #fff; }
</style></head>
<body>
  <h1>${escapeHtml(content.title)}</h1>
  <p class="lead">Sending a report helps us fix the problem. No prompts, transcripts, screenshots, or recordings are included.</p>
  <div class="err">${escapeHtml(content.errorLabel)}</div>
  <p class="meta">${escapeHtml(content.whenLabel)} · ${escapeHtml(content.origin)}${content.errorCode ? ` · ${escapeHtml(content.errorCode)}` : ""}</p>
  <label class="note" for="note">Add a note (optional)</label>
  <textarea id="note" maxlength="${content.noteMaxLength}" placeholder="What were you doing when it crashed?"></textarea>
  <div class="row">
    <input type="checkbox" id="logs" checked />
    <label for="logs">Attach a summary of the last 30 seconds of diagnostic logs</label>
  </div>
  <div class="actions">
    <button id="decline">Don't send</button>
    <button id="send" class="primary">Send report</button>
  </div>
  <script>
    function go(send) {
      var note = send ? document.getElementById('note').value : '';
      var logs = send && document.getElementById('logs').checked ? '1' : '0';
      var url = '${content.eventScheme}submit?send=' + (send ? '1' : '0') + '&logs=' + logs +
                '&note=' + encodeURIComponent(note.slice(0, ${content.noteMaxLength}));
      window.location.href = url;
    }
    document.getElementById('send').addEventListener('click', function () { go(true); });
    document.getElementById('decline').addEventListener('click', function () { go(false); });
  </script>
</body></html>`;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
