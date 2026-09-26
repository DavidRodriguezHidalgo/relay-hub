import { describe, expect, it, vi } from 'vitest';
import { loadWhenServing } from './dev-server-load';

/** A window whose server comes up after `failures` refused connections. */
function target(failures: number) {
  let calls = 0;
  return {
    calls: () => calls,
    loadURL: vi.fn(async () => {
      calls += 1;
      if (calls <= failures) throw new Error('ERR_CONNECTION_REFUSED (-102) loading http://localhost:5173/');
    }),
  };
}
const noSleep = () => Promise.resolve();

describe('loadWhenServing', () => {
  it('loads at once when the server is already up', async () => {
    const t = target(0);
    expect(await loadWhenServing(t, 'http://localhost:5173/', { sleep: noSleep })).toBe(1);
  });

  it('keeps trying until the server answers, instead of leaving the window blank', async () => {
    const t = target(4);
    expect(await loadWhenServing(t, 'http://localhost:5173/', { sleep: noSleep })).toBe(5);
    expect(t.calls()).toBe(5);
  });

  it('waits between attempts rather than hammering the port', async () => {
    const sleep = vi.fn(async () => undefined);
    await loadWhenServing(target(2), 'http://localhost:5173/', { sleep, delayMs: 250 });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('gives up with a message that names the server, after the attempts allowed', async () => {
    const t = target(99);
    await expect(loadWhenServing(t, 'http://localhost:5173/', { attempts: 3, sleep: noSleep })).rejects.toThrow(/localhost:5173.*3 attempts/);
    expect(t.calls()).toBe(3);
  });
});
