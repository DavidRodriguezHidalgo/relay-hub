import type { UpdateCheck } from '@relay/shared';

/** The little of fetch this needs, so a test can hand in a fake without DOM types. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface UpdateSource {
  /** `owner/name` on GitHub; releases are read from its public API. */
  repo: string;
  currentVersion: string;
  fetch?: FetchLike;
}

/** `owner/name` from the ways package.json spells a repository, or null when it is not GitHub. */
export function repoFromPackage(repository: unknown): string | null {
  const text = typeof repository === 'string' ? repository : (repository as { url?: unknown } | null)?.url;
  if (typeof text !== 'string') return null;
  const m = text.match(/(?:^github:|github\.com[/:])([^/]+)\/([^/#.]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Numeric parts first; a pre-release tag sorts below the same release. Leading `v` is ignored. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) => {
    const [core = '', pre] = v.replace(/^v/i, '').split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Compares what is running with the newest release on GitHub.
 *
 * A repository with no release yet is not an error: the check says so and reports nothing newer.
 * Any failure to ask is reported in `error` rather than thrown, so a window can show it as is.
 */
export async function checkForUpdate(source: UpdateSource): Promise<UpdateCheck> {
  const base: UpdateCheck = {
    current: source.currentVersion, latest: null, newer: false, url: null, notes: null, publishedAt: null, error: null,
  };
  const fetchFn = source.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchFn) return { ...base, error: 'no way to reach GitHub from here' };
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(`https://api.github.com/repos/${source.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'relay-hub' },
    });
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 404) return base; // nothing published yet
  if (!res.ok) return { ...base, error: `GitHub answered ${res.status}` };
  const release = (await res.json()) as { tag_name?: unknown; html_url?: unknown; body?: unknown; published_at?: unknown };
  if (typeof release.tag_name !== 'string') return { ...base, error: 'GitHub sent a release without a version' };
  const latest = release.tag_name.replace(/^v/i, '');
  return {
    ...base,
    latest,
    newer: compareVersions(latest, source.currentVersion) > 0,
    url: typeof release.html_url === 'string' ? release.html_url : null,
    notes: typeof release.body === 'string' && release.body.trim() ? release.body.trim() : null,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
  };
}
