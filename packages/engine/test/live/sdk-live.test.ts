import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORCHESTRATOR_KEY, type RunnerEvent } from '@relay/shared';
import { RelayEngine } from '../../src/relay-engine';

/**
 * Drives a real Claude Code session through the SDK. Opt in with
 * `RELAY_LIVE=<project dir name under ~/.claude/projects>` (e.g. `-private-tmp-relay-scratch`);
 * it spends tokens on the account logged into `claude`.
 */
const LIVE = process.env.RELAY_LIVE;
/** A second scratch session for the bulk case; skipped when it does not exist. */
const LIVE_2 = process.env.RELAY_LIVE_2 ?? '-private-tmp-relay-scratch-2';

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
    const source2 = join(homedir(), '.claude', 'projects', LIVE_2);
    const has2 = await stat(source2).then(() => true, () => false);
    if (has2) {
      const f2 = (await readdir(source2)).filter((f) => f.endsWith('.jsonl'));
      if (f2[0]) {
        await mkdir(join(root, 'projects', LIVE_2), { recursive: true });
        const copy2 = join(root, 'projects', LIVE_2, f2[0]);
        await copyFile(join(source2, f2[0]), copy2);
        await utimes(copy2, old, old);
      }
    }
    engine = await RelayEngine.start({
      projectsDir: join(root, 'projects'),
      dbPath: join(root, 'relay.db'),
      orchestratorDir: join(root, 'orch'),
    });
    engine.onEvent((e) => events.push(e));
    sessionId = engine.listSessions().find((s) => s.filePath.includes(`/${LIVE!}/`))!.id;
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

  it('the orchestrator finds the scratch session, sends to it and reports the turn end', async () => {
    events.length = 0;
    await engine.orchestratorSend(
      'Send the session in repo relay-scratch this instruction: "Reply with exactly the word: relayed". Do not ask me to confirm.',
    );
    const said = (id: string, word: string) =>
      events.some(
        (e) =>
          e.type === 'entry' &&
          e.sessionId === id &&
          e.entry.role === 'assistant' &&
          e.entry.blocks.some((b) => b.kind === 'text' && b.text.toLowerCase().includes(word)),
      );
    await waitFor(() => said(sessionId, 'relayed'), 180_000);
    await waitFor(
      () => events.some((e) => e.type === 'entry' && e.sessionId === ORCHESTRATOR_KEY && e.entry.origin === 'watch:turn-end'),
      180_000,
    );
  }, 600_000);

  it('the orchestrator proposes a bulk run over both scratch sessions; confirmed rows answer; one summary comes back', async () => {
    const ids = engine.listSessions().map((x) => x.id);
    if (ids.length < 2) {
      console.warn(`bulk live case skipped: no second scratch session under ~/.claude/projects/${LIVE_2}`);
      return;
    }
    events.length = 0;
    await engine.orchestratorSend(
      'Ask every session in repos relay-scratch and relay-scratch-2 to reply with exactly the word: bulked. Use one bulk action.',
    );
    await waitFor(() => engine.runState().bulkRuns.some((r) => r.status === 'proposed'), 180_000);
    const run = engine.runState().bulkRuns.find((r) => r.status === 'proposed')!;
    expect(run.rows).toHaveLength(2);
    engine.bulkConfirm(run.id, run.rows.map((r) => r.sessionId));
    await waitFor(() => engine.runState().bulkRuns.find((r) => r.id === run.id)?.status === 'finished', 300_000);
    const finished = engine.runState().bulkRuns.find((r) => r.id === run.id)!;
    expect(finished.rows.map((r) => r.status)).toEqual(['done', 'done']);
    await waitFor(
      () => events.some((e) => e.type === 'entry' && e.sessionId === ORCHESTRATOR_KEY && e.entry.origin === 'watch:bulk-end'),
      120_000,
    );
  }, 800_000);
});
