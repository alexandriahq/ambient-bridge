import { describe, expect, it } from 'vitest';
import { LoginStartGate } from './login-start-gate.js';

describe('login startup ownership', () => {
  it('shares startup while the callback listener is still opening', async () => {
    const gate = new LoginStartGate();
    let starts = 0;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const first = gate.run(async () => { starts++; await wait; });
    const second = gate.run(async () => { starts++; });
    expect(second).toBe(first);
    await Promise.resolve();
    expect(starts).toBe(1);
    release(); await first;
  });
  it('invalidates late startup on explicit cancellation or organization replacement', async () => {
    const gate = new LoginStartGate();
    const ownership: Array<() => boolean> = [];
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const first = gate.run(async current => { ownership.push(current); await wait; }, 'a');
    await Promise.resolve();
    const second = gate.run(async current => { ownership.push(current); await wait; }, 'b');
    await Promise.resolve();
    expect(ownership.map(current => current())).toEqual([false, true]);
    gate.cancel();
    expect(ownership.map(current => current())).toEqual([false, false]);
    release(); await Promise.all([first, second]);
  });
});
