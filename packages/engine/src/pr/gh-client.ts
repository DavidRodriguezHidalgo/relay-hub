import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const VIEW_FIELDS =
  'number,url,title,state,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,reviews,comments';

export interface PrCheck {
  name: string;
  conclusion: string | null;
  status: string | null;
}

export interface PrFeedback {
  id: string;
  author: string;
  body: string;
  at: string;
}

/** What Relay needs to know about one PR, with CheckRuns/StatusContexts and reviews/comments unified. */
export interface PrData {
  number: number;
  url: string;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  checks: PrCheck[];
  feedback: PrFeedback[];
}

export interface PrRef {
  repo: string;
  number: number;
  url: string;
}

export type MyPr = PrRef & { title: string; headRefName: string; state: string };

export interface GhClient {
  viewer(): Promise<string>;
  viewPr(repo: string, number: number): Promise<PrData>;
  findPrForBranch(cwd: string, branch: string): Promise<PrRef | null>;
  listMyPrs(): Promise<MyPr[]>;
}

/** Runs `gh` with the given arguments and returns its stdout. */
export type RunGh = (args: string[], opts?: { cwd?: string }) => Promise<string>;

const defaultRun: RunGh = async (args, opts) => {
  try {
    const { stdout } = await exec('gh', args, { cwd: opts?.cwd, timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
};

/** https://github.com/owner/name/pull/1 → owner/name */
export function repoFromPrUrl(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length >= 3 && parts[2] === 'pull' ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}

type RawCheck = {
  __typename?: string;
  name?: string;
  context?: string;
  conclusion?: string | null;
  status?: string | null;
  state?: string;
};

type RawFeedback = {
  id: string;
  author?: { login?: string };
  body?: string;
  state?: string;
  submittedAt?: string;
  createdAt?: string;
};

/** Talks to GitHub through the `gh` CLI, so it acts with the user's own login. */
export class ExecGhClient implements GhClient {
  constructor(private readonly run: RunGh = defaultRun) {}

  async viewer(): Promise<string> {
    return (await this.run(['api', 'user', '--jq', '.login'])).trim();
  }

  async viewPr(repo: string, number: number): Promise<PrData> {
    const raw = JSON.parse(
      await this.run(['pr', 'view', String(number), '--repo', repo, '--json', VIEW_FIELDS]),
    ) as Record<string, unknown>;
    const checks = ((raw.statusCheckRollup as RawCheck[] | null) ?? []).map((c) =>
      c.__typename === 'StatusContext'
        ? { name: c.context ?? '', conclusion: c.state ?? null, status: 'COMPLETED' }
        : { name: c.name ?? '', conclusion: c.conclusion ?? null, status: c.status ?? null },
    );
    // a bare COMMENTED review with no body is just the envelope of inline comments; skip it
    const reviews = ((raw.reviews as RawFeedback[] | null) ?? [])
      .filter((r) => (r.body ?? '').trim() !== '' || r.state !== 'COMMENTED')
      .map((r) => ({
        id: r.id,
        author: r.author?.login ?? '',
        body: (r.body ?? '').trim() || (r.state ?? ''),
        at: r.submittedAt ?? '',
      }));
    const comments = ((raw.comments as RawFeedback[] | null) ?? []).map((c) => ({
      id: c.id,
      author: c.author?.login ?? '',
      body: c.body ?? '',
      at: c.createdAt ?? '',
    }));
    return {
      number: raw.number as number,
      url: raw.url as string,
      title: raw.title as string,
      state: raw.state as PrData['state'],
      headRefName: raw.headRefName as string,
      headRefOid: raw.headRefOid as string,
      baseRefName: raw.baseRefName as string,
      mergeable: raw.mergeable as PrData['mergeable'],
      mergeStateStatus: raw.mergeStateStatus as string,
      checks,
      feedback: [...reviews, ...comments].sort((a, b) => a.at.localeCompare(b.at)),
    };
  }

  async findPrForBranch(cwd: string, branch: string): Promise<PrRef | null> {
    const rows = JSON.parse(
      await this.run(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1'], { cwd }),
    ) as { number: number; url: string }[];
    const row = rows[0];
    const repo = row ? repoFromPrUrl(row.url) : null;
    return row && repo ? { repo, number: row.number, url: row.url } : null;
  }

  /** `gh search prs` finds the repos but has no branch field; `gh pr list` per repo supplies it. */
  async listMyPrs(): Promise<MyPr[]> {
    const found = JSON.parse(
      await this.run(['search', 'prs', '--author', '@me', '--state', 'open', '--json', 'repository', '--limit', '100']),
    ) as { repository?: { nameWithOwner?: string } }[];
    const repos = [...new Set(found.flatMap((r) => (r.repository?.nameWithOwner ? [r.repository.nameWithOwner] : [])))];
    const prs: MyPr[] = [];
    for (const repo of repos) {
      const rows = JSON.parse(
        await this.run([
          'pr', 'list', '--repo', repo, '--author', '@me', '--state', 'open',
          '--json', 'number,url,title,headRefName,state', '--limit', '50',
        ]),
      ) as { number: number; url: string; title: string; headRefName: string; state: string }[];
      prs.push(...rows.map((r) => ({ repo, ...r })));
    }
    return prs;
  }
}
