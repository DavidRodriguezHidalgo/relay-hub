import { describe, expect, it } from 'vitest';
import type { AccountUsage } from '../src/usage';
import { pressingWindow, resetWording, usageLevel, usageSentence } from '../src/usage';

const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({
  available: true,
  plan: 'team',
  checkedAt: '2026-10-02T08:30:00.000Z',
  windows: [
    { kind: 'five-hour', percent: 26, resetsAt: '2026-10-02T12:29:59.000Z' },
    { kind: 'seven-day', percent: 53, resetsAt: '2026-10-06T03:59:59.000Z' },
  ],
  ...over,
});

describe('usageLevel', () => {
  it('stays calm while there is plenty left', () => {
    expect(usageLevel(0)).toBe('calm');
    expect(usageLevel(59)).toBe('calm');
  });

  it('rises through the thresholds rather than jumping straight to alarm', () => {
    expect(usageLevel(60)).toBe('notable');
    expect(usageLevel(80)).toBe('tight');
    expect(usageLevel(92)).toBe('critical');
    expect(usageLevel(100)).toBe('critical');
  });
});

describe('pressingWindow', () => {
  it('picks the window furthest through, because that is the one that will stop you', () => {
    expect(pressingWindow(usage())?.kind).toBe('seven-day');
  });

  it('picks the other one when the session window is the fuller', () => {
    const nearly = usage({
      windows: [
        { kind: 'five-hour', percent: 94, resetsAt: '2026-10-02T12:29:59.000Z' },
        { kind: 'seven-day', percent: 53, resetsAt: '2026-10-06T03:59:59.000Z' },
      ],
    });
    expect(pressingWindow(nearly)?.kind).toBe('five-hour');
  });

  it('has nothing to point at when the limits could not be read', () => {
    expect(pressingWindow(usage({ available: false, windows: [] }))).toBeNull();
    expect(pressingWindow(null)).toBeNull();
  });
});

describe('resetWording', () => {
  const now = new Date('2026-10-02T08:30:00.000Z');

  it('gives a time for today and a weekday beyond it', () => {
    expect(resetWording('2026-10-02T12:29:59.000Z', now)).toMatch(/^at /);
    // 03:59 UTC is the Tuesday morning the usage screen calls 'Tue 6:00 AM' in this timezone
    expect(resetWording('2026-10-06T03:59:59.000Z', now)).toMatch(/^Tue /);
  });

  it('says it does not know rather than printing Invalid Date', () => {
    expect(resetWording('not a date', now)).toBe('at an unknown time');
  });
});

describe('usageSentence', () => {
  const now = new Date('2026-10-02T08:30:00.000Z');

  it('spells out every window, since the strip only has room for the worst', () => {
    const said = usageSentence(usage(), now);
    expect(said).toContain('Current session: 26% used');
    expect(said).toContain('This week: 53% used');
  });

  it('says plainly that it cannot read them rather than implying nothing is used', () => {
    expect(usageSentence(usage({ available: false, windows: [] }), now)).toMatch(/cannot read/);
  });

  it('says it is still looking before the first answer arrives', () => {
    expect(usageSentence(null, now)).toMatch(/Checking/);
  });
});
