import { describe, expect, it } from 'vitest';
import { classifyToolUse, patternKey } from '../../src/approvals/rules';

const cwd = '/Users/me/code/repo';
const bash = (command: string) => classifyToolUse('Bash', { command }, cwd);

describe('classifyToolUse', () => {
  it.each([
    'git push --force origin feat',
    'git push -f',
    'git push origin +main',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git branch -D old',
    'git rebase main',
    'git commit --amend --no-edit',
    'git filter-repo --path x',
    'rm -rf dist',
    'rm -fr dist',
    'git fetch && git reset --hard origin/main',
    'pnpm build; git push --force-with-lease',
  ])('asks for destructive git / rm: %s', (command) => {
    expect(bash(command)).toMatchObject({ outcome: 'ask', reason: 'destructive-git', summary: command });
  });

  it.each([
    'git status',
    'git push origin feat',
    'git commit -m "x"',
    'git rebase --continue',
    'git branch -d merged',
    'rm dist/out.js',
    'pnpm test',
    `cat ${cwd}/README.md`,
    'ls /tmp/x && cat /private/tmp/y',
  ])('allows ordinary commands: %s', (command) => {
    expect(bash(command)).toEqual({ outcome: 'allow' });
  });

  it('asks when a Bash command touches a path outside the cwd', () => {
    expect(bash('cat /Users/me/code/other/secret.env')).toMatchObject({ outcome: 'ask', reason: 'outside-cwd' });
    expect(bash(`cp ${cwd}/a /Users/me/Desktop/a`)).toMatchObject({ outcome: 'ask', reason: 'outside-cwd' });
  });

  it('asks when a file tool targets a path outside the cwd, allows inside', () => {
    expect(classifyToolUse('Edit', { file_path: '/Users/me/code/other/x.ts' }, cwd)).toMatchObject({
      outcome: 'ask',
      reason: 'outside-cwd',
      summary: '/Users/me/code/other/x.ts',
    });
    expect(classifyToolUse('Write', { file_path: `${cwd}/src/x.ts` }, cwd)).toEqual({ outcome: 'allow' });
    expect(classifyToolUse('Read', { file_path: '/tmp/scratch.txt' }, cwd)).toEqual({ outcome: 'allow' });
  });

  it('asks when the SDK reports a blocked path', () => {
    expect(classifyToolUse('Bash', { command: 'ls' }, cwd, '/etc/hosts')).toMatchObject({
      outcome: 'ask',
      reason: 'blocked-path',
      summary: '/etc/hosts',
    });
  });

  it('allows unknown tools', () => {
    expect(classifyToolUse('WebFetch', { url: 'https://x' }, cwd)).toEqual({ outcome: 'allow' });
  });
});

describe('patternKey', () => {
  it('is tool + first two command words for Bash, tool name otherwise', () => {
    expect(patternKey('Bash', { command: 'git push --force origin x' })).toBe('Bash git push');
    expect(patternKey('Bash', { command: 'rm -rf dist' })).toBe('Bash rm -rf');
    expect(patternKey('Edit', { file_path: '/x' })).toBe('Edit');
  });
});
