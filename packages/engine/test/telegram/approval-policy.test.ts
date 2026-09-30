import { describe, expect, it } from 'vitest';
import type { PendingApproval } from '@relay/shared';
import { phoneApprovalVerdict } from '../../src/telegram/approval-policy';

const bash = (command: string, over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: 'a1',
  sessionId: 's1',
  toolName: 'Bash',
  input: { command },
  summary: command,
  reason: 'destructive-git',
  cwd: '/Users/me/code/repo',
  createdAt: '2026-09-30T10:00:00.000Z',
  ...over,
});

describe('phoneApprovalVerdict', () => {
  it.each([
    'git rebase main',
    'git rebase -i HEAD~3',
    'git commit --amend --no-edit',
    'git push --force-with-lease origin feat/x',
    'git push --force-with-lease=feat/x:abc origin feat/x',
    'git fetch && git rebase origin/main && git push --force-with-lease',
    'pnpm test && git commit --amend --no-edit',
  ])('may be allowed once from a phone: %s', (command) => {
    expect(phoneApprovalVerdict(bash(command))).toEqual({ allowOnce: true });
  });

  it.each([
    ['rm -rf dist', /deletes/],
    ['git push --force origin feat/x', /overwrite/],
    ['git push -f', /overwrite/],
    ['git push origin +main', /overwrite/],
    ['git push --force-with-lease --force', /overwrite/],
    ['git push --delete origin feat/x', /overwrite/],
    ['git push origin :feat/x', /overwrite/],
    ['git push --mirror', /overwrite/],
    ['git reset --hard HEAD~1', /machine/],
    ['git clean -fd', /machine/],
    ['git branch -D old', /machine/],
    ['git filter-repo --path x', /machine/],
    ['git rebase main && rm -rf node_modules', /deletes/],
    ['git commit --amend && git push -f', /overwrite/],
  ])('must wait for the machine: %s', (command, why) => {
    const verdict = phoneApprovalVerdict(bash(command));
    expect(verdict.allowOnce).toBe(false);
    expect(verdict.allowOnce === false && verdict.why).toMatch(why);
  });

  it('never allows a step outside the session folder or on a blocked path, whatever the command', () => {
    const outside = phoneApprovalVerdict(bash('cat ~/.ssh/id_rsa', { reason: 'outside-cwd', summary: 'cat ~/.ssh/id_rsa' }));
    expect(outside.allowOnce).toBe(false);
    expect(outside.allowOnce === false && outside.why).toMatch(/outside/);
    const blocked = phoneApprovalVerdict({ ...bash('x'), reason: 'blocked-path', toolName: 'Write', input: { file_path: '/etc/hosts' }, summary: '/etc/hosts' });
    expect(blocked.allowOnce).toBe(false);
    expect(blocked.allowOnce === false && blocked.why).toMatch(/blocked/);
  });

  it('refuses anything that is not a shell command it can read', () => {
    const verdict = phoneApprovalVerdict({ ...bash('x'), toolName: 'Bash', input: {} });
    expect(verdict.allowOnce).toBe(false);
  });
});
