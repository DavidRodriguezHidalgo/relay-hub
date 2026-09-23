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

  it("reports which sessions are open elsewhere and whether they are busy", async () => {
    await writeFile(join(dir, "100.json"), JSON.stringify({ pid: 100, sessionId: "s1", status: "busy" }));
    await writeFile(join(dir, "200.json"), JSON.stringify({ pid: 200, sessionId: "s2", status: "idle" }));
    await writeFile(join(dir, "300.json"), JSON.stringify({ pid: 300, sessionId: "s3", status: "busy" })); // Relay's own
    await writeFile(join(dir, "400.json"), JSON.stringify({ pid: 400, sessionId: "s4", status: "busy" })); // dead
    const registry = new ClaudeSessionRegistry({ dir, isAlive: (pid) => pid !== 400, isOwnDescendant: async (pid) => pid === 300 });
    expect(await registry.openSessions()).toEqual({ s1: "busy", s2: "idle" });
  });
});

describe('ClaudeSessionRegistry and Relay’s own drivers', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-registry-own-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const write = (pid: number, sessionId: string) =>
    writeFile(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, status: 'idle' }));

  it('does not count a driver Relay started as a foreign holder, even one left by an earlier run', async () => {
    await write(100, 's1'); // a terminal
    await write(200, 's1'); // a driver this Relay started: reachable by ancestry
    await write(300, 's1'); // a driver an EARLIER Relay left behind: only the env marker identifies it
    const registry = new ClaudeSessionRegistry({
      dir,
      isAlive: () => true,
      isOwnDescendant: async (pid) => pid === 200,
      readEnv: async (pid) => (pid === 300 ? 'PATH=/usr/bin RELAY_HUB_DRIVER=1\n' : 'PATH=/usr/bin\n'),
    });
    expect(await registry.foreignHolders('s1')).toEqual([100]);
    expect(await registry.openSessions()).toEqual({ s1: 'idle' });
  });

  it('treats a process whose environment cannot be read as somebody else’s', async () => {
    await write(100, 's1');
    const registry = new ClaudeSessionRegistry({
      dir,
      isAlive: () => true,
      isOwnDescendant: async () => false,
      readEnv: async () => {
        throw new Error('not permitted');
      },
    });
    expect(await registry.foreignHolders('s1')).toEqual([100]);
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

  const base = { isOwnDescendant: async () => false, readEnv: async () => '', sleep: async () => undefined };

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
