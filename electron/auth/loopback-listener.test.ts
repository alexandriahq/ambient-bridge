import { afterEach, describe, expect, it } from 'vitest';
import { LoopbackLoginListener, type LoginCallbackOutcome } from './loopback-listener.js';
const listeners: LoopbackLoginListener[] = [];
afterEach(() => { for (const listener of listeners.splice(0)) listener.close(); });
function create(callback: (query: string) => Promise<LoginCallbackOutcome>, graceMs?: number) {
  const listener = new LoopbackLoginListener(callback, graceMs);
  listeners.push(listener); return listener;
}
describe('loopback callback transport', () => {
  it('reuses a port so a replaced tab can get an explanation without completing the new attempt', async () => {
    let active = 'old';
    const completed: string[] = [];
    const listener = create(async query => {
      const state = new URLSearchParams(query).get('client_state');
      if (state !== active) return 'replaced';
      completed.push(state); return 'success';
    });
    const url = await listener.open();
    listener.retainForOldTabs(); active = 'new';
    expect(await listener.open()).toBe(url);
    const stale = await fetch(`${url}?client_state=old`);
    expect(stale.status).toBe(410);
    expect(await stale.text()).toContain('replaced or expired');
    expect(completed).toEqual([]);
    const current = await fetch(`${url}?client_state=new`);
    expect(current.status).toBe(200);
    expect(completed).toEqual(['new']);
    expect(current.headers.get('cache-control')).toBe('no-store');
  });
  it('waits for redemption and persistence before claiming success', async () => {
    let finish!: (outcome: LoginCallbackOutcome) => void;
    const pending = new Promise<LoginCallbackOutcome>(resolve => { finish = resolve; });
    let entered!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    const listener = create(async () => { entered(); return pending; });
    const url = await listener.open();
    let responded = false;
    const response = fetch(url).then(value => { responded = true; return value; });
    await called;
    expect(responded).toBe(false);
    finish('failed');
    expect((await response).status).toBe(400);
    expect(await (await response).text()).toContain('could not be completed');
  });
  it('rejects other paths and methods and closes during startup', async () => {
    const listener = create(async () => 'success');
    const url = await listener.open();
    expect((await fetch(url, { method: 'POST' })).status).toBe(400);
    expect((await fetch(url.replace('/auth/callback', '/other'))).status).toBe(404);
    listener.close();
    const opening = listener.open(); listener.close();
    await expect(opening).rejects.toThrow('closed');
  });
});
