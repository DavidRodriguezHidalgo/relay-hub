import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountUsageFrom } from '../../src/usage/account-usage';
import { RelayEngine } from '../../src/relay-engine';
import { FakeAgentClient } from '../runner/fake-agent-client';

/** An engine whose runtime answers usage the way the given function does, or cannot answer at all. */
async function usageEngine(reply: (() => Promise<unknown>) | undefined) {
  const root = await mkdtemp(join(tmpdir(), 'relay-usage-'));
  await mkdir(join(root, 'projects'), { recursive: true });
  let calls = 0;
  const client = new FakeAgentClient() as FakeAgentClient & { accountUsage?: () => Promise<unknown> };
  if (reply) client.accountUsage = async () => { calls += 1; return reply(); };
  const engine = await RelayEngine.start({
    projectsDir: join(root, 'projects'),
    dbPath: join(root, 'relay.db'),
    orchestratorDir: join(root, 'orch'),
    agent: client,
    registry: { foreignHolders: async () => [] },
  });
  return { engine, asked: () => calls, close: async () => { await engine.close(); await rm(root, { recursive: true, force: true }); } };
}

/** The shape the SDK really returns, trimmed; the codenamed buckets are left in on purpose. */
const REAL = {
  session: { total_cost_usd: 0, model_usage: {} },
  subscription_type: 'team',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 26, resets_at: '2026-10-02T12:29:59.575020+00:00', limit_dollars: null },
    seven_day: { utilization: 53, resets_at: '2026-10-06T03:59:59.575048+00:00', limit_dollars: null },
    seven_day_opus: null,
    seven_day_sonnet: null,
    iguana_necktie: null,
    extra_usage: { is_enabled: false, utilization: null, currency: 'EUR' },
  },
};

describe('accountUsageFrom', () => {
  it('reads the two windows the source actually fills in', () => {
    expect(accountUsageFrom(REAL, '2026-10-02T08:30:00.000Z')).toEqual({
      available: true,
      plan: 'team',
      checkedAt: '2026-10-02T08:30:00.000Z',
      windows: [
        { kind: 'five-hour', percent: 26, resetsAt: '2026-10-02T12:29:59.575020+00:00' },
        { kind: 'seven-day', percent: 53, resetsAt: '2026-10-06T03:59:59.575048+00:00' },
      ],
    });
  });

  it('says so plainly when the source reports no limits rather than inventing zero', () => {
    const out = accountUsageFrom({ ...REAL, rate_limits_available: false }, 'now');
    expect(out.available).toBe(false);
    expect(out.windows).toEqual([]);
  });

  it('treats a missing or unrecognisable answer as not knowing', () => {
    for (const bad of [null, undefined, 'nope', {}, { rate_limits_available: true }]) {
      expect(accountUsageFrom(bad, 'now').available).toBe(false);
    }
  });

  it('keeps a window only when it carries both a number and a reset, never half of one', () => {
    const half = {
      ...REAL,
      rate_limits: { five_hour: { utilization: 26 }, seven_day: { resets_at: '2026-10-06T03:59:59Z' } },
    };
    expect(accountUsageFrom(half, 'now').windows).toEqual([]);
  });

  it('ignores buckets it cannot name, rather than guessing which model they belong to', () => {
    const extra = {
      ...REAL,
      rate_limits: { ...REAL.rate_limits, iguana_necktie: { utilization: 44, resets_at: '2026-10-06T03:59:59Z' } },
    };
    expect(accountUsageFrom(extra, 'now').windows.map((w) => w.kind)).toEqual(['five-hour', 'seven-day']);
  });

  it('is available with no plan name, since the number is the point and the name is not', () => {
    const anon = { ...REAL, subscription_type: null };
    expect(accountUsageFrom(anon, 'now')).toMatchObject({ available: true, plan: null });
  });
});

describe('RelayEngine.accountUsage', () => {
  const payload = {
    subscription_type: 'team',
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 26, resets_at: '2026-10-02T12:29:59Z' } },
  };

  it('reports what the runtime says, and asks it only once inside the cache window', async () => {
    const { engine, asked, close } = await usageEngine(async () => payload);
    const first = await engine.accountUsage();
    expect(first).toMatchObject({ available: true, plan: 'team' });
    expect(first.windows[0]).toEqual({ kind: 'five-hour', percent: 26, resetsAt: '2026-10-02T12:29:59Z' });
    await engine.accountUsage();
    // polling from the window must not spawn a runtime process every time
    expect(asked()).toBe(1);
    await close();
  });

  it('says it does not know when the runtime cannot tell it, rather than reporting zero', async () => {
    const { engine, close } = await usageEngine(undefined);
    expect(await engine.accountUsage()).toMatchObject({ available: false, windows: [] });
    await close();
  });

  it('says it does not know when the experimental call fails, rather than throwing at the window', async () => {
    const { engine, close } = await usageEngine(async () => {
      throw new Error('usage_EXPERIMENTAL… is gone');
    });
    expect(await engine.accountUsage()).toMatchObject({ available: false });
    await close();
  });
});
