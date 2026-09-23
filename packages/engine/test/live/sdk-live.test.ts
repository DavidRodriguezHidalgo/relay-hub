import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerEvent } from '@relay/shared';
import { RelayEngine } from '../../src/relay-engine';

/**
 * Drives a real Claude Code session through the SDK. Opt in with
 * `RELAY_LIVE=<project dir name under ~/.claude/projects>` (e.g. `-private-tmp-relay-scratch`);
 * it spends tokens on the account logged into `claude`.
 */
const LIVE = process.env.RELAY_LIVE;

describe.skipIf(!LIVE)('SdkAgentClient against a real session', () => {
  let root: string;
  let engine: RelayEngine;
  let sessionId: string;
  const events: RunnerEvent[] = [];

  const waitFor = (pred: () => boolean, ms = 120_000) =>
    new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const t = setInterval(() => {
        if (pred()) {
          clearInterval(t);
          resolve();
        } else if (Date.now() - started > ms) {
          clearInterval(t);
          reject(new Error(`timeout; events so far: ${JSON.stringify(events.map((e) => e.type))}`));
        }
      }, 100);
    });
  const idle = () => events.at(-1)?.type === 'state' && (events.at(-1) as { state: string }).state === 'idle';
  const texts = () =>
    events.flatMap((e) =>
      e.type === 'entry' ? e.entry.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])) : [],
    );

  beforeAll(async () => {
    const source = join(homedir(), '.claude', 'projects', LIVE!);
    const files = (await readdir(source)).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    root = await mkdtemp(join(tmpdir(), 'relay-live-'));
    await mkdir(join(root, 'projects', LIVE!), { recursive: true });
    const copy = join(root, 'projects', LIVE!, files[0]!);
    await copyFile(join(source, files[0]!), copy);
    const old = new Date(Date.now() - 60_000);
    await utimes(copy, old, old);
    engine = await RelayEngine.start({
      projectsDir: join(root, 'projects'),
      dbPath: join(root, 'relay.db'),
      orchestratorDir: join(root, 'orch'),
    });
    engine.onEvent((e) => events.push(e));
    sessionId = engine.listSessions()[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await engine?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('answers a steer and returns to idle', async () => {
    await engine.send({ sessionId, prompt: 'Reply with exactly the word: pong', mode: 'steer', origin: 'user' });
    await waitFor(idle);
    expect(texts().join('\n').toLowerCase()).toContain('pong');
    expect(engine.runState().states[sessionId]).toEqual({ state: 'idle', error: null });
  }, 150_000);

  it('a steer sent mid-turn folds into the turn and the session still returns to idle', async () => {
    events.length = 0;
    await engine.send({
      sessionId,
      prompt: 'Use the Bash tool to run `sleep 8`, then reply with the word: first',
      mode: 'steer',
      origin: 'user',
    });
    await waitFor(() => events.some((e) => e.type === 'entry'));
    await engine.send({ sessionId, prompt: 'Also end your reply with the word: second', mode: 'steer', origin: 'user' });
    await waitFor(idle);
    expect(engine.runState().states[sessionId]).toEqual({ state: 'idle', error: null });
  }, 150_000);

  it('an interrupt ends the turn without an error and the interrupt message is answered', async () => {
    events.length = 0;
    await engine.send({ sessionId, prompt: 'Use the Bash tool to run `sleep 60`', mode: 'steer', origin: 'user' });
    await waitFor(() => events.some((e) => e.type === 'entry'));
    await engine.send({ sessionId, prompt: 'Stop. Reply with exactly the word: done', mode: 'interrupt', origin: 'user' });
    await waitFor(idle, 90_000);
    expect(events.some((e) => e.type === 'state' && e.state === 'error')).toBe(false);
    expect(texts().join('\n').toLowerCase()).toContain('done');
  }, 150_000);

  it('holds a force-push for approval; deny reaches the agent', async () => {
    events.length = 0;
    await engine.send({
      sessionId,
      prompt: 'Run exactly this shell command with the Bash tool and tell me what happened: git push --force origin main',
      mode: 'steer',
      origin: 'user',
    });
    await waitFor(() => events.some((e) => e.type === 'approval'));
    const approval = events.find((e) => e.type === 'approval')!;
    expect(approval.type === 'approval' && approval.approval.reason).toBe('destructive-git');
    expect(engine.runState().states[sessionId]?.state).toBe('waiting-approval');
    engine.decide((approval as { approval: { id: string } }).approval.id, { kind: 'deny', message: 'not from Relay' });
    await waitFor(idle);
    expect(events.some((e) => e.type === 'approval-resolved')).toBe(true);
  }, 150_000);
});
