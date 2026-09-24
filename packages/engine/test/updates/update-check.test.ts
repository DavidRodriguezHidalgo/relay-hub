import { describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, repoFromPackage, type FetchLike } from '../../src/updates/update-check';

const answer = (status: number, body: unknown): FetchLike => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('compareVersions', () => {
  it('orders releases the way people expect', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
  });
});

describe('repoFromPackage', () => {
  it('reads the ways a package names its GitHub repository', () => {
    expect(repoFromPackage('github:DavidRodriguezHidalgo/relay-hub')).toBe('DavidRodriguezHidalgo/relay-hub');
    expect(repoFromPackage({ type: 'git', url: 'https://github.com/o/r.git' })).toBe('o/r');
    expect(repoFromPackage('git@github.com:o/r.git')).toBe('o/r');
    expect(repoFromPackage('https://gitlab.com/o/r')).toBeNull();
    expect(repoFromPackage(undefined)).toBeNull();
  });
});

describe('checkForUpdate', () => {
  const repo = 'o/r';

  it('reports a newer release with where to get it and what changed', async () => {
    const fetch = answer(200, { tag_name: 'v0.2.0', html_url: 'https://github.com/o/r/releases/tag/v0.2.0', body: '- faster\n- fixes\n', published_at: '2026-09-24T10:00:00Z' });
    expect(await checkForUpdate({ repo, currentVersion: '0.1.0', fetch })).toEqual({
      current: '0.1.0', latest: '0.2.0', newer: true, url: 'https://github.com/o/r/releases/tag/v0.2.0',
      notes: '- faster\n- fixes', publishedAt: '2026-09-24T10:00:00Z', error: null,
    });
  });

  it('says you are up to date when the newest release is what is running', async () => {
    const result = await checkForUpdate({ repo, currentVersion: '0.2.0', fetch: answer(200, { tag_name: 'v0.2.0', html_url: 'u', body: '' }) });
    expect(result).toMatchObject({ latest: '0.2.0', newer: false, notes: null, error: null });
  });

  it('treats no release at all as nothing newer, not as a failure', async () => {
    expect(await checkForUpdate({ repo, currentVersion: '0.1.0', fetch: answer(404, { message: 'Not Found' }) })).toMatchObject({ latest: null, newer: false, error: null });
  });

  it('reports why it could not check, instead of throwing', async () => {
    expect(await checkForUpdate({ repo, currentVersion: '0.1.0', fetch: answer(403, {}) })).toMatchObject({ error: 'GitHub answered 403' });
    const offline: FetchLike = async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); };
    expect(await checkForUpdate({ repo, currentVersion: '0.1.0', fetch: offline })).toMatchObject({ error: 'getaddrinfo ENOTFOUND api.github.com' });
  });
});
