import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { RelayEngine } from '../../src/relay-engine';

/**
 * Proves a real session comes up on the model Relay asked for, rather than on the machine's saved
 * default. Opt in with `RELAY_LIVE_MODEL=1`; it creates throwaway repositories and sessions and
 * costs two very short turns.
 *
 * This is the check the unit tests cannot make: they can only show that Relay passes a model, not
 * that passing one actually beats the `model` saved in the user's own settings file.
 */
const run = promisify(execFile);
const live = process.env.RELAY_LIVE_MODEL === '1';

/** The transcript writes the plain model id, without the context-window suffix a choice may carry. */
const bare = (model: string) => model.replace(/\[[^\]]*\]$/, '');

async function scratchRepo(root: string): Promise<string> {
  const repo = join(root, 'probe-repo');
  await mkdir(repo);
  await run('git', ['init', '-b', 'main'], { cwd: repo });
  await run('git', ['config', 'user.email', 'probe@example.com'], { cwd: repo });
  await run('git', ['config', 'user.name', 'probe'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# probe\n');
  await run('git', ['add', '-A'], { cwd: repo });
  await run('git', ['commit', '-m', 'init'], { cwd: repo });
  return repo;
}

/** Every model the session's own transcript says it ran on. */
function modelsInTranscript(sessionId: string): string[] {
  const dir = join(homedir(), '.claude', 'projects');
  const file = readdirSync(dir, { recursive: true, encoding: 'utf8' }).find((f) => f.endsWith(`${sessionId}.jsonl`));
  if (!file) throw new Error(`No transcript for ${sessionId}`);
  const models = readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return (JSON.parse(line) as { message?: { model?: unknown } }).message?.model;
      } catch {
        return null;
      }
    })
    .filter((m): m is string => typeof m === 'string');
  return [...new Set(models)];
}

describe.skipIf(!live)('the model a session Relay creates actually runs on', () => {
  it('uses what Relay asked for, not the default saved in the settings file', { timeout: 600_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-model-probe-'));
    const repo = await scratchRepo(root);
    const engine = await RelayEngine.start({
      projectsDir: join(homedir(), '.claude', 'projects'),
      dbPath: join(root, 'relay.db'),
      orchestratorDir: join(root, 'orch'),
      // short enough to watch the runner close, which is what ten quiet minutes does in real use
      idleTimeoutMs: 3_000,
    });
    try {
      const create = async (branch: string) => {
        const { sessionId } = await engine.createSession({
          project: repo, branch, prompt: 'Reply with the single word: ok', origin: 'user',
        });
        for (let i = 0; i < 300 && engine.runState().states[sessionId]?.state === 'running'; i += 1) {
          await new Promise((r) => setTimeout(r, 1_000));
        }
        return modelsInTranscript(sessionId);
      };

      const saved = engine.settings().claudeDefaultModel;
      const recommended = await engine.newSessionModel();
      const onRecommended = await create('feat/model-probe-recommended');
      console.log(`saved default: ${saved}`);
      console.log(`asked for ${JSON.stringify(recommended)} -> ran on ${onRecommended.join(', ')}`);
      expect(onRecommended).toEqual([bare(recommended.resolvedModel!)]);

      const other = (await engine.availableModels()).find((m) => m.id === 'sonnet');
      engine.setNewSessionModel(other!.id);
      const chosen = await engine.newSessionModel();
      const onChosen = await create('feat/model-probe-chosen');
      console.log(`asked for ${JSON.stringify(chosen)} -> ran on ${onChosen.join(', ')}`);
      expect(onChosen).toEqual([bare(chosen.resolvedModel!)]);

      // the point of the whole change: neither session inherited what the settings file says
      if (saved) expect([...onRecommended, ...onChosen]).not.toContain(bare(saved));

      // And it has to survive the runner being closed, which happens after ten idle minutes and
      // on every restart. That path builds a fresh runner, so it has to ask for the model again.
      const { sessionId } = await engine.createSession({
        project: repo, branch: 'feat/model-probe-reopened', prompt: 'Reply with the single word: ok', origin: 'user',
      });
      for (let i = 0; i < 300 && engine.runState().states[sessionId]?.state === 'running'; i += 1) {
        await new Promise((r) => setTimeout(r, 1_000));
      }
      for (let i = 0; i < 60 && engine.runState().states[sessionId]; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(engine.runState().states[sessionId]).toBeUndefined();
      // a transcript written seconds ago reads as held by another writer; wait that window out
      await new Promise((r) => setTimeout(r, 18_000));
      await engine.send({ sessionId, prompt: 'Reply with the single word: again', mode: 'steer', origin: 'user' });
      for (let i = 0; i < 300 && engine.runState().states[sessionId]?.state === 'running'; i += 1) {
        await new Promise((r) => setTimeout(r, 1_000));
      }
      const afterReopen = modelsInTranscript(sessionId);
      console.log(`after the runner closed and was rebuilt -> ran on ${afterReopen.join(', ')}`);
      expect(afterReopen).toEqual([bare(chosen.resolvedModel!)]);
    } finally {
      await engine.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
