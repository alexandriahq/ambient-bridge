import { createServer, type Server } from 'node:http';
export type LoginCallbackOutcome = 'success' | 'replaced' | 'failed';
const messages: Record<LoginCallbackOutcome, string> = {
  success: 'Sign-in complete. You can return to Ambient.',
  replaced: 'This sign-in was replaced or expired. Return to Ambient and continue the latest attempt.',
  failed: 'Sign-in could not be completed. Return to Ambient and try again.',
};
/** One loopback endpoint per Bridge lifetime, with bounded idle retention for old tabs. */
export class LoopbackLoginListener {
  private server?: Server;
  private opening?: Promise<string>;
  private abort?: AbortController;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(private readonly callback: (query: string) => Promise<LoginCallbackOutcome>, private readonly graceMs = 5 * 60_000) {}
  async open(): Promise<string> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    if (this.opening) return this.opening;
    const address = this.server?.address();
    if (address && typeof address !== 'string') return `http://127.0.0.1:${address.port}/auth/callback`;
    const server = createServer((request, response) => {
      const address = server.address();
      if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}` || request.method !== 'GET') {
        response.writeHead(400); response.end('Invalid callback request'); return;
      }
      let url: URL;
      try { url = new URL(request.url ?? '/', `http://127.0.0.1:${address.port}`); }
      catch { response.writeHead(400); response.end('Invalid callback request'); return; }
      if (url.pathname !== '/auth/callback') { response.writeHead(404); response.end('Not found'); return; }
      void this.callback(url.search).catch((): LoginCallbackOutcome => 'failed').then(outcome => {
        response.writeHead(outcome === 'success' ? 200 : outcome === 'replaced' ? 410 : 400, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        });
        response.end(`<!doctype html><title>Ambient sign-in</title><p>${messages[outcome]}</p>`);
      });
    });
    this.server = server;
    const abort = new AbortController();
    this.abort = abort;
    const opening = new Promise<string>((resolve, reject) => {
      abort.signal.addEventListener("abort", () => reject(new Error("Sign-in listener closed.")), { once: true });
      server.once('error', reject);
      server.listen({ port: 0, host: '127.0.0.1', signal: abort.signal }, () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('Could not start sign-in listener.')); return; }
        resolve(`http://127.0.0.1:${address.port}/auth/callback`);
      });
    });
    this.opening = opening;
    try { return await opening; } catch (error) {
      if (this.server === server) { this.server = undefined; this.abort = undefined; }
      server.close();
      throw error;
    } finally { if (this.opening === opening) this.opening = undefined; }
  }
  retainForOldTabs(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), this.graceMs);
    this.idle.unref();
  }
  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    const server = this.server; this.server = undefined;
    this.abort?.abort(); this.abort = undefined;
    this.opening = undefined;
    if (server) { server.close(); server.closeIdleConnections(); }
  }
}
