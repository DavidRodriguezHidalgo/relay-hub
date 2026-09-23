import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSessionRegistry } from '../../src/runner/session-registry';

describe('ClaudeSessionRegistry', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-registry-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const entry = (pid: number, sessionId: string) =>
    writeFile(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, kind: 'interactive', entrypoint: 'cli' }));

  it('reports live processes that hold the session and are not ours', async () => {
    await entry(100, 's1'); // a terminal, alive
    await entry(200, 's1'); // Relay's own child, alive
    await entry(300, 's1'); // dead
    await entry(400, 's2'); // another session
    await writeFile(join(dir, '100.abc.key'), 'x');
    await writeFile(join(dir, 'broken.json'), '{');
    const registry = new ClaudeSessionRegistry({
      dir,
      isAlive: (pid) => pid !== 300,
      isOwnDescendant: async (pid) => pid === 200,
    });
    expect(await registry.foreignHolders('s1')).toEqual([100]);
    expect(await registry.foreignHolders('s3')).toEqual([]);
  });

  it('treats a missing registry directory as nobody holding anything', async () => {
    const registry = new ClaudeSessionRegistry({ dir: join(dir, 'nope') });
    expect(await registry.foreignHolders('s1')).toEqual([]);
  });

  it('by default sees the current process as alive and not its own descendant', async () => {
    await entry(process.pid, 's1');
    expect(await new ClaudeSessionRegistry({ dir }).foreignHolders('s1')).toEqual([process.pid]);
  });
});
