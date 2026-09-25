import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { applyCheckout, inspectCheckout, type RunCommand } from '../../src/updates/checkout-update';

const exec = promisify(execFile);
const run: RunCommand = async (cmd, args, cwd) =>
  exec(cmd, cmd === 'git' ? ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args] : args, { cwd });

describe('inspectCheckout', () => {
  let root: string;
  let origin: string;
  let clone: string;
  const git = (cwd: string, ...args: string[]) => run('git', args, cwd);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'relay-co-'));
    origin = join(root, 'origin.git');
    clone = join(root, 'clone');
    const seed = join(root, 'seed');
    await exec('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    await exec('git', ['init', '-q', '-b', 'main', seed]);
    await writeFile(join(seed, 'a.txt'), 'one');
    await writeFile(join(seed, 'package.json'), '{"name":"x"}');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-q', '-m', 'first');
    await git(seed, 'remote', 'add', 'origin', origin);
    await git(seed, 'push', '-q', 'origin', 'main');
    await exec('git', ['clone', '-q', origin, clone]);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  /** Adds a commit to the remote, as if someone else had pushed. */
  const pushUpstream = async (file: string, message: string) => {
    const seed = join(root, 'seed');
    await writeFile(join(seed, file), 'later');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-q', '-m', message);
    await git(seed, 'push', '-q', 'origin', 'main');
  };

  it('says there is nothing to do when the checkout is level with the remote', async () => {
    expect(await inspectCheckout(clone, run)).toMatchObject({ kind: 'up-to-date', branch: 'main', reason: null });
  });

  it('lists what pulling would bring in', async () => {
    await pushUpstream('b.txt', 'second');
    const plan = await inspectCheckout(clone, run);
    expect(plan.kind).toBe('ready');
    expect(plan.commits.map((c) => c.subject)).toEqual(['second']);
    expect(plan.needsInstall).toBe(false);
  });

  it('notices when the dependencies would change', async () => {
    await pushUpstream('pnpm-lock.yaml', 'bump deps');
    expect((await inspectCheckout(clone, run)).needsInstall).toBe(true);
  });

  it('refuses while there is uncommitted work, and says it will not touch it', async () => {
    await pushUpstream('b.txt', 'second');
    await writeFile(join(clone, 'a.txt'), 'mine');
    const plan = await inspectCheckout(clone, run);
    expect(plan.kind).toBe('refused');
    expect(plan.reason).toMatch(/not committed/i);
    expect(plan.reason).toMatch(/will not touch/i);
  });

  it('refuses when pulling would have to merge rather than fast-forward', async () => {
    await pushUpstream('b.txt', 'theirs');
    await writeFile(join(clone, 'c.txt'), 'mine');
    await git(clone, 'add', '.');
    await git(clone, 'commit', '-q', '-m', 'mine');
    const plan = await inspectCheckout(clone, run);
    expect(plan.kind).toBe('refused');
    expect(plan.reason).toMatch(/would have to merge/i);
  });

  it('refuses on a detached head', async () => {
    const sha = (await git(clone, 'rev-parse', 'HEAD')).stdout.trim();
    await git(clone, 'checkout', '-q', sha);
    expect(await inspectCheckout(clone, run)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/detached head/i) });
  });

  it('refuses on a branch that tracks nothing', async () => {
    await git(clone, 'checkout', '-q', '-b', 'local-only');
    const plan = await inspectCheckout(clone, run);
    expect(plan.kind).toBe('refused');
    expect(plan.reason).toMatch(/tracks no remote/i);
  });

  it('refuses outside a git working copy', async () => {
    expect(await inspectCheckout(root, run)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/not a git/i) });
  });

  describe('applyCheckout', () => {
    it('fast-forwards and reports what was pulled', async () => {
      await pushUpstream('b.txt', 'second');
      const result = await applyCheckout(clone, run);
      expect(result).toMatchObject({ pulled: [{ subject: 'second' }], installed: false, error: null });
      expect((await git(clone, 'log', '-1', '--format=%s')).stdout.trim()).toBe('second');
    });

    it('installs the dependencies when they changed', async () => {
      await pushUpstream('pnpm-lock.yaml', 'bump deps');
      const installs: string[][] = [];
      const result = await applyCheckout(clone, run, async (cmd, args) => {
        installs.push([cmd, ...args]);
        return { stdout: '' };
      });
      expect(installs).toEqual([['pnpm', 'install']]);
      expect(result.installed).toBe(true);
    });

    it('keeps the pull but says so when installing fails, rather than leaving it ambiguous', async () => {
      await pushUpstream('pnpm-lock.yaml', 'bump deps');
      const result = await applyCheckout(clone, run, async () => {
        throw new Error('network down');
      });
      expect(result.pulled).toHaveLength(1);
      expect(result.installed).toBe(false);
      expect(result.error).toMatch(/pulled, but installing/i);
      expect(result.error).toMatch(/pnpm install yourself/i);
    });

    it('will not apply anything it refused to plan', async () => {
      await pushUpstream('b.txt', 'second');
      await writeFile(join(clone, 'a.txt'), 'mine');
      await expect(applyCheckout(clone, run)).rejects.toThrow(/not committed/i);
      expect((await git(clone, 'status', '--porcelain')).stdout).toContain('a.txt');
    });
  });
});
