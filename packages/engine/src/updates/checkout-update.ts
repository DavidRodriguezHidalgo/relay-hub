/** Runs a command somewhere; the real one shells out, a test hands in its own. */
export type RunCommand = (cmd: string, args: string[], cwd: string) => Promise<{ stdout: string }>;

export interface CheckoutPlan {
  /** `ready` is the only one that may be applied. */
  kind: 'up-to-date' | 'ready' | 'refused';
  /** Why it will not proceed, when it will not. */
  reason: string | null;
  branch: string | null;
  upstream: string | null;
  /** What pulling would bring in, newest first. */
  commits: { sha: string; subject: string }[];
  /** Whether those commits change the dependencies. */
  needsInstall: boolean;
}

export interface CheckoutResult {
  pulled: { sha: string; subject: string }[];
  installed: boolean;
  /** What went wrong after the pull, when something did. The pull itself stands. */
  error: string | null;
}

/** Files whose change means the dependencies must be installed again. */
const DEPENDENCY_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

const lines = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

/**
 * Whether this working copy can be brought up to date, and what that would bring.
 *
 * It fetches, which touches nothing in the working tree, and then refuses on anything it
 * cannot do safely: uncommitted work, a detached head, a branch tracking nothing, or a pull
 * that would not fast-forward. It never stashes, resets or discards; a refusal leaves the
 * checkout exactly as it was and says why.
 */
export async function inspectCheckout(dir: string, run: RunCommand): Promise<CheckoutPlan> {
  const empty: CheckoutPlan = { kind: 'refused', reason: null, branch: null, upstream: null, commits: [], needsInstall: false };
  const git = async (...args: string[]) => (await run('git', args, dir)).stdout.trim();

  let branch: string;
  try {
    branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  } catch {
    return { ...empty, reason: 'This is not a git working copy.' };
  }
  if (branch === 'HEAD') return { ...empty, reason: 'The checkout is on no branch (detached head). Check out a branch first.' };

  let upstream: string;
  try {
    upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
  } catch {
    return { ...empty, branch, reason: `${branch} tracks no remote branch, so there is nothing to pull.` };
  }

  const dirty = lines(await git('status', '--porcelain'));
  if (dirty.length > 0) {
    return {
      ...empty,
      branch,
      upstream,
      reason: `${dirty.length} file${dirty.length === 1 ? '' : 's'} changed but not committed. Commit or put them aside yourself first — Relay will not touch them.`,
    };
  }

  try {
    await run('git', ['fetch', '--quiet'], dir);
  } catch (err) {
    return { ...empty, branch, upstream, reason: `Could not reach the remote: ${err instanceof Error ? err.message : String(err)}` };
  }

  const commits = lines(await git('log', '--format=%H%x00%s', `HEAD..${upstream}`))
    .map((l) => l.split('\0'))
    .filter((p) => p.length === 2)
    .map(([sha, subject]) => ({ sha: sha!, subject: subject! }));
  if (commits.length === 0) return { ...empty, kind: 'up-to-date', branch, upstream };

  try {
    await run('git', ['merge-base', '--is-ancestor', 'HEAD', upstream], dir);
  } catch {
    return {
      ...empty,
      branch,
      upstream,
      commits,
      reason: `${branch} has commits ${upstream} does not, so pulling would have to merge. Sort that out yourself — Relay only fast-forwards.`,
    };
  }

  const changed = lines(await git('diff', '--name-only', `HEAD..${upstream}`));
  return {
    kind: 'ready',
    reason: null,
    branch,
    upstream,
    commits,
    needsInstall: changed.some((f) => DEPENDENCY_FILES.some((d) => f === d || f.endsWith(`/${d}`))),
  };
}

/**
 * Brings the working copy up to date, having checked again that it is safe to.
 *
 * Only ever a fast-forward. If installing the dependencies afterwards fails, the pull still
 * stands and the error says so, rather than leaving it ambiguous.
 */
export async function applyCheckout(dir: string, run: RunCommand, install?: RunCommand): Promise<CheckoutResult> {
  const plan = await inspectCheckout(dir, run);
  if (plan.kind !== 'ready') throw new Error(plan.reason ?? 'There is nothing to update.');

  await run('git', ['merge', '--ff-only', plan.upstream!], dir);
  if (!plan.needsInstall) return { pulled: plan.commits, installed: false, error: null };

  try {
    await (install ?? run)('pnpm', ['install'], dir);
    return { pulled: plan.commits, installed: true, error: null };
  } catch (err) {
    return {
      pulled: plan.commits,
      installed: false,
      error: `The changes were pulled, but installing the dependencies failed: ${err instanceof Error ? err.message : String(err)}. Run pnpm install yourself.`,
    };
  }
}
