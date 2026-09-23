import { describe, expect, it } from 'vitest';
import type { Invocable } from '@relay/shared';
import { CommandCatalog } from '../../src/commands/command-catalog';

const cmd = (name: string): Invocable => ({ name, description: `does ${name}`, argumentHint: '' });

describe('CommandCatalog', () => {
  it('asks the agent once per directory and serves later calls from the cache', async () => {
    const asked: string[] = [];
    const catalog = new CommandCatalog(async (cwd) => {
      asked.push(cwd);
      return [cmd(`in-${cwd}`)];
    });
    expect(await catalog.list('/a')).toEqual([cmd('in-/a')]);
    expect(await catalog.list('/a')).toEqual([cmd('in-/a')]);
    expect(await catalog.list('/b')).toEqual([cmd('in-/b')]);
    expect(asked).toEqual(['/a', '/b']);
  });

  it('shares one lookup between calls that arrive together', async () => {
    let asked = 0;
    const catalog = new CommandCatalog(async () => {
      asked += 1;
      await Promise.resolve();
      return [cmd('review')];
    });
    const [first, second] = await Promise.all([catalog.list('/a'), catalog.list('/a')]);
    expect(first).toEqual(second);
    expect(asked).toBe(1);
  });

  it('answers with nothing when the agent cannot be asked, and tries again next time', async () => {
    let calls = 0;
    const catalog = new CommandCatalog(async () => {
      calls += 1;
      if (calls === 1) throw new Error('claude not found');
      return [cmd('review')];
    });
    expect(await catalog.list('/a')).toEqual([]);
    expect(await catalog.list('/a')).toEqual([cmd('review')]);
    expect(calls).toBe(2);
  });

  it('has nothing to offer when the runtime cannot list commands at all', async () => {
    expect(await new CommandCatalog(undefined).list('/a')).toEqual([]);
  });
});
