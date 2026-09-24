import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { classifyToolUse, tooBroadPattern } from '../../src/approvals/rules';

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
    // spellings a chain can hide behind
    'rm -r -f dist',
    'rm --recursive --force dist',
    'RM -RF dist',
    'git -c core.x=y push -f',
    'GIT_TRACE=1 git push -f',
    'sudo git push -f',
    'command git reset --hard',
    'xargs rm -rf',
    'sh -c "git push -f"',
    "bash -c 'git reset --hard'",
    'echo $(git push -f)',
    'echo `git push -f`',
    '(git push -f)',
    'git fetch & git reset --hard',
    'git push origin :main',
    'git push --delete origin main',
    'git push --mirror',
    'git  push   --force',
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
    'rm -r dist',
    'pnpm test',
    `cat ${cwd}/README.md`,
    'ls /tmp/x && cat /private/tmp/y',
    'pnpm test > /dev/null 2>&1',
    '/usr/bin/env node -v',
    'echo "no path: here"',
    'git push --force-if-includes origin feat',
  ])('allows ordinary commands: %s', (command) => {
    expect(bash(command)).toEqual({ outcome: 'allow' });
  });

  it.each([
    'cat /Users/me/code/other/secret.env',
    `cp ${cwd}/a /Users/me/Desktop/a`,
    'cat "/Users/me/code/other/secret.env"',
    "cat '/etc/passwd'",
    'cat "/Users/me/my docs/notes.txt"',
    'curl --config=/etc/x',
    'cat ~/.ssh/id_rsa',
    'cat $HOME/.zshrc',
    'cp x ../../other/',
    'git -C ../other status',
    'git -C /Users/me/other status',
  ])('asks when a Bash command touches a path outside the cwd: %s', (command) => {
    expect(bash(command)).toMatchObject({ outcome: 'ask', reason: 'outside-cwd', summary: command });
  });

  it('asks when a file tool targets a path outside the cwd, allows inside', () => {
    expect(classifyToolUse('Edit', { file_path: '/Users/me/code/other/x.ts' }, cwd)).toMatchObject({
      outcome: 'ask',
      reason: 'outside-cwd',
      summary: '/Users/me/code/other/x.ts',
    });
    expect(classifyToolUse('Write', { file_path: '../other/x.ts' }, cwd)).toMatchObject({ outcome: 'ask', reason: 'outside-cwd' });
    expect(classifyToolUse('Write', { file_path: `${cwd}/src/x.ts` }, cwd)).toEqual({ outcome: 'allow' });
    expect(classifyToolUse('Write', { file_path: 'src/x.ts' }, cwd)).toEqual({ outcome: 'allow' });
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

  describe('patternKey names the offending step, not the first words of the line', () => {
    it.each([
      ['git fetch && git reset --hard origin/main', 'Bash git reset'],
      ['cd /x && git push -f', 'Bash git push'],
      ['sh -c "git push -f"', 'Bash git push'],
      ['rm -rf dist', 'Bash rm -rf'],
      ['GIT_TRACE=1 git push -f', 'Bash git push'],
    ])('%s → %s', (command, key) => {
      expect(bash(command)).toMatchObject({ outcome: 'ask', patternKey: key });
    });

    it('keys out-of-cwd paths by their directory', () => {
      expect(bash('cat /Users/me/code/other/secret.env')).toMatchObject({ patternKey: 'Bash path /Users/me/code/other' });
      expect(classifyToolUse('Edit', { file_path: '/Users/me/code/other/x.ts' }, cwd)).toMatchObject({
        patternKey: 'Edit /Users/me/code/other',
      });
      expect(classifyToolUse('Bash', { command: 'ls' }, cwd, '/etc/hosts')).toMatchObject({ patternKey: 'Bash blocked /etc' });
    });
  });
});

describe('classifyToolUse pattern keys', () => {
  // one approval should cover a project, not each of its folders in turn
  const inRepo = (p: string) => (p.startsWith('/work/relay-hub') ? '/work/relay-hub' : null);

  it('keys an out-of-cwd command on the repository it touches, so subfolders do not ask again', () => {
    const key = (command: string) =>
      classifyToolUse('Bash', { command }, '/work/other', undefined, inRepo);
    const first = key('pnpm --dir /work/relay-hub/apps/desktop test');
    expect(first).toMatchObject({ outcome: 'ask', reason: 'outside-cwd', patternKey: 'Bash path /work/relay-hub' });
    expect(key('cat /work/relay-hub/packages/engine/src/index.ts')).toMatchObject({
      patternKey: 'Bash path /work/relay-hub',
    });
  });

  it('keys a file outside the cwd on its repository too', () => {
    expect(
      classifyToolUse('Edit', { file_path: '/work/relay-hub/packages/shared/src/ipc.ts' }, '/work/other', undefined, inRepo),
    ).toMatchObject({ outcome: 'ask', patternKey: 'Edit /work/relay-hub' });
  });

  it('falls back to the directory when the path is in no repository', () => {
    expect(classifyToolUse('Bash', { command: 'cat /etc/hosts/x/y' }, '/work/other', undefined, () => null)).toMatchObject({
      patternKey: 'Bash path /etc/hosts/x',
    });
  });
});

describe('what counts as a path at all', () => {
  const cwd = '/work/repo';
  const verdict = (command: string) => classifyToolUse('Bash', { command }, cwd);

  it('does not mistake an awk or sed program for a path outside the session', () => {
    // these ask every time otherwise, and each one under a key of its own, so allowing never helps
    expect(verdict(`awk '/^type Foo /{f=1} f{print} f&&/^}/{exit}' schema.graphql`)).toEqual({ outcome: 'allow' });
    expect(verdict(`awk '/^<<<<<<< HEAD/,/^>>>>>>>/' file.txt`)).toEqual({ outcome: 'allow' });
    expect(verdict(`sed -n '/calculate(/,/^}/p' src/x.ts`)).toEqual({ outcome: 'allow' });
    expect(verdict(`grep -nE '^(type|interface) ' schema.graphql`)).toEqual({ outcome: 'allow' });
  });

  it('still stops a command that really does reach outside', () => {
    expect(verdict('cat /work/other/secrets.txt')).toMatchObject({ outcome: 'ask', reason: 'outside-cwd' });
  });

  it('never offers the whole disk or the whole home directory as one allowable kind', () => {
    const root = verdict('cat /rogue-file');
    expect(root).toMatchObject({ outcome: 'ask', patternKey: 'Bash path /rogue-file' });
    const home = classifyToolUse('Edit', { file_path: `${homedir()}/.zshrc` }, cwd);
    expect(home).toMatchObject({ outcome: 'ask', patternKey: `Edit ${homedir()}/.zshrc` });
  });
});

describe('tooBroadPattern', () => {
  it('recognises a kind that would allow everything', () => {
    expect(tooBroadPattern('Bash path /')).toBe(true);
    expect(tooBroadPattern(`Edit ${homedir()}`)).toBe(true);
    expect(tooBroadPattern('Bash path /work/repo')).toBe(false);
    expect(tooBroadPattern('Bash git push')).toBe(false);
  });
});
