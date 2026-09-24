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
  const sdkEntry = (pid: number, sessionId: string) =>
    writeFile(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, kind: 'interactive', entrypoint: 'sdk-cli' }));

  it('reports live processes that hold the session and are not ours', async () => {
    await entry(100, 's1'); // a terminal, alive
    await sdkEntry(200, 's1'); // Relay's own child, alive
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

  it("reports which sessions are open elsewhere and whether they are busy", async () => {
    await writeFile(join(dir, "100.json"), JSON.stringify({ pid: 100, sessionId: "s1", status: "busy" }));
    await writeFile(join(dir, "200.json"), JSON.stringify({ pid: 200, sessionId: "s2", status: "idle" }));
    await writeFile(join(dir, "300.json"), JSON.stringify({ pid: 300, sessionId: "s3", status: "busy", entrypoint: "sdk-cli" })); // Relay's own agent
    await writeFile(join(dir, "400.json"), JSON.stringify({ pid: 400, sessionId: "s4", status: "busy" })); // dead
    const registry = new ClaudeSessionRegistry({ dir, isAlive: (pid) => pid !== 400, isOwnDescendant: async (pid) => pid === 300 });
    expect(await registry.openSessions()).toEqual({ s1: "busy", s2: "idle" });
  });
});


describe('ClaudeSessionRegistry.release', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-registry-release-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const write = (pid: number, sessionId: string) =>
    writeFile(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, status: 'busy' }));

  const base = { isOwnDescendant: async () => false, sleep: async () => undefined };

  it('stops every process holding the session and waits until they are gone', async () => {
    await write(100, 's1');
    await write(200, 's1');
    await write(300, 's2');
    const stopped: number[] = [];
    const dead = new Set<number>();
    const registry = new ClaudeSessionRegistry({
      ...base,
      dir,
      isAlive: (pid) => !dead.has(pid),
      terminate: (pid) => {
        stopped.push(pid);
        dead.add(pid);
      },
    });
    expect(await registry.release('s1')).toEqual([100, 200]);
    expect(stopped).toEqual([100, 200]);
  });

  it('refuses to stop a process Relay itself is running inside', async () => {
    await write(100, 's1');
    const registry = new ClaudeSessionRegistry({
      ...base,
      dir,
      isAlive: () => true,
      isOwnAncestor: async (pid) => pid === 100,
      terminate: () => {
        throw new Error('must not be stopped');
      },
    });
    await expect(registry.release('s1')).rejects.toThrow(/runs inside/);
  });

  it('gives up when a process will not exit', async () => {
    await write(100, 's1');
    const registry = new ClaudeSessionRegistry({
      ...base,
      dir,
      isAlive: () => true,
      terminate: () => undefined,
      releaseTimeoutMs: 400,
    });
    await expect(registry.release('s1')).rejects.toThrow(/did not exit/);
  });
});

describe('ClaudeSessionRegistry and entries left by a dead process', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-registry-stale-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const WHEN = 'Tue Sep 23 17:11:02 2026';
  const write = (pid: number, procStart?: string) =>
    writeFile(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: 's1', status: 'busy', procStart }));
  const base = { isOwnDescendant: async () => false, isAlive: () => true };

  it('ignores an entry whose pid the system has since given to another process', async () => {
    await write(100, WHEN);
    const registry = new ClaudeSessionRegistry({ ...base, dir, readStart: async () => 'Wed Sep 24 09:00:00 2026' });
    expect(await registry.foreignHolders('s1')).toEqual([]);
    expect(await registry.openSessions()).toEqual({});
  });

  it('keeps an entry whose process is still the one that wrote it', async () => {
    await write(100, WHEN);
    const registry = new ClaudeSessionRegistry({ ...base, dir, readStart: async () => WHEN });
    expect(await registry.foreignHolders('s1')).toEqual([100]);
  });

  it('keeps an entry with no recorded start, and one whose start cannot be read', async () => {
    await write(100);
    await write(200, WHEN);
    const registry = new ClaudeSessionRegistry({
      ...base,
      dir,
      readStart: async (pid) => {
        if (pid === 200) throw new Error('no such process');
        return 'unused';
      },
    });
    expect(await registry.foreignHolders('s1')).toEqual([100, 200]);
  });
});

describe('ClaudeSessionRegistry and a terminal started from inside Relay', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-registry-terminal-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('still counts a terminal that Relay happens to be an ancestor of', async () => {
    // a person opened Claude inside a session Relay drives: descended from Relay, yet really holding it
    await writeFile(join(dir, '100.json'), JSON.stringify({ pid: 100, sessionId: 's1', entrypoint: 'cli' }));
    await writeFile(join(dir, '200.json'), JSON.stringify({ pid: 200, sessionId: 's1', entrypoint: 'sdk-cli' }));
    const registry = new ClaudeSessionRegistry({ dir, isAlive: () => true, isOwnDescendant: async () => true });
    expect(await registry.foreignHolders('s1')).toEqual([100]);
  });
});
