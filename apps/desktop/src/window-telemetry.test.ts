// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { startWindowReporting } from './window-telemetry';

describe('startWindowReporting', () => {
  it('does not start the SDK while reports are not allowed', async () => {
    const load = vi.fn();
    expect(await startWindowReporting(async () => false, load as never)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('starts once allowed, and scrubs on this side too', async () => {
    const init = vi.fn();
    const started = await startWindowReporting(async () => true, async () => ({ init }) as never);
    expect(started).toBe(true);
    const beforeSend = (init.mock.calls[0]?.[0] as { beforeSend: (e: unknown) => unknown }).beforeSend;
    expect(beforeSend({ message: 'broke in /Users/someone/code/private-thing', extra: { branch: 'x' } })).toEqual({
      message: 'broke in ~/<path>',
    });
  });

  it('opens the window anyway when reporting cannot start', async () => {
    expect(await startWindowReporting(async () => { throw new Error('no ipc'); })).toBe(false);
  });
});
