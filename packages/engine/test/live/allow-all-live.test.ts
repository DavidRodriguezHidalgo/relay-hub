import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerEvent } from '@relay/shared';
import { RelayEngine } from '../../src/relay-engine';

/**
 * Drives a real session twice. Opt in with `RELAY_LIVE_ALLOW_ALL=<session id>`; the session's
 * directory must be a scratch git repository, because the command it is told to run is
 * `git reset --hard HEAD`. Costs a couple of short turns.
 */
const sessionId = process.env.RELAY_LIVE_ALLOW_ALL;
const PROMPT =
  'Run exactly this shell command in the current directory and nothing else, then reply with the single word done: git reset --hard HEAD';

const until = async (check: () => boolean, ms: number, what: string) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe.skipIf(!sessionId)('allow-all against a real session', () => {
  it('skips approval when on, and asks again when off', async () => {
    const id = sessionId!;
    const root = await mkdtemp(join(tmpdir(), 'relay-live-allow-'));
    const engine = await RelayEngine.start({
      projectsDir: join(homedir(), '.claude', 'projects'),
      dbPath: join(root, 'relay.db'),
      orchestratorDir: join(root, 'orch'),
    });
    const events: RunnerEvent[] = [];
    engine.onEvent((e) => events.push(e));
    const ranReset = () =>
      events.some(
        (e) =>
          e.type === 'entry' &&
          e.sessionId === id &&
          e.entry.blocks.some((b) => b.kind === 'tool_use' && b.name === 'Bash' && String((b.input as { command?: string })?.command).includes('git reset --hard')),
      );
    const idleAfter = (from: number) =>
      events.slice(from).some((e) => e.type === 'state' && e.sessionId === id && e.state === 'idle');
    const approvals = () => events.filter((e) => e.type === 'approval' && e.approval.sessionId === id);
    try {
      // ON: the destructive command runs without a single approval being raised
      engine.setAllowAllActions(true);
      await engine.send({ sessionId: id, prompt: PROMPT, mode: 'steer', origin: 'user' });
      await until(ranReset, 150_000, 'the reset to run with everything allowed');
      const mark = events.length;
      await until(() => idleAfter(mark - 1), 120_000, 'the turn to end');
      expect(approvals()).toEqual([]);
      console.log(`ON: ran git reset --hard with ${approvals().length} approvals raised`);

      // OFF: the same command is held for the user
      engine.setAllowAllActions(false);
      const before = events.length;
      await engine.send({ sessionId: id, prompt: PROMPT, mode: 'steer', origin: 'user' });
      await until(() => approvals().length > 0, 150_000, 'an approval to be raised with everything allowed off');
      const [asked] = approvals();
      expect(asked!.type === 'approval' && asked!.approval.reason).toBe('destructive-git');
      console.log(`OFF: held "${asked!.type === 'approval' ? asked!.approval.summary : ''}" for approval`);
      engine.decide(asked!.type === 'approval' ? asked!.approval.id : '', { kind: 'deny', message: 'live check, not for real' });
      await until(() => idleAfter(before), 120_000, 'the denied turn to end');
    } finally {
      await engine.close();
    }
  }, 480_000);
});
