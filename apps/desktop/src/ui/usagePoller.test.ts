import { describe, expect, it, vi } from 'vitest';
import { pollUsage } from './usagePoller';

function harness(read: () => Promise<string>) {
  let timer: (() => void) | null = null;
  let focus: (() => void) | null = null;
  const onValue = vi.fn();
  const onGiveUp = vi.fn();
  const stop = pollUsage({
    read,
    onValue,
    onGiveUp,
    intervalMs: 1000,
    setInterval: (fn) => {
      timer = fn;
      return 1;
    },
    clearInterval: () => {
      timer = null;
    },
    addFocusListener: (fn) => {
      focus = fn;
    },
    removeFocusListener: () => {
      focus = null;
    },
  });
  return { onValue, onGiveUp, stop, tick: () => timer?.(), refocus: () => focus?.(), live: () => timer !== null };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('pollUsage', () => {
  it('reads at once rather than waiting out the first interval', async () => {
    const { onValue } = harness(async () => 'first');
    await settle();
    expect(onValue).toHaveBeenCalledWith('first');
  });

  it('keeps reading on the timer and when the window comes back', async () => {
    const { onValue, tick, refocus } = harness(async () => 'again');
    await settle();
    tick();
    refocus();
    await settle();
    expect(onValue).toHaveBeenCalledTimes(3);
  });

  it('gives up after one failure instead of logging an error on every attempt', async () => {
    const read = vi.fn(async () => {
      throw new Error('No handler registered');
    });
    const { onGiveUp, tick, refocus, live } = harness(read as unknown as () => Promise<string>);
    await settle();
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(live()).toBe(false);
    tick();
    refocus();
    await settle();
    // the one read that failed, and nothing after it
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reports nothing more once stopped, even if a read was already in flight', async () => {
    let release: ((v: string) => void) | undefined;
    const { onValue, stop } = harness(() => new Promise<string>((r) => (release = r)));
    stop();
    release?.('late');
    await settle();
    expect(onValue).not.toHaveBeenCalled();
  });
});
