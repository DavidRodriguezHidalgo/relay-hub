import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '@relay/shared';
import { imagesIn } from '../../src/visual/screenshots';

const entry = (over: Partial<TranscriptEntry>): TranscriptEntry => ({
  uuid: 'u', role: 'assistant', timestamp: '2026-09-25T10:00:00.000Z', isSidechain: false, isMeta: false,
  blocks: [], ...over,
});

const used = (name: string, input: unknown, timestamp = '2026-09-25T10:00:00.000Z') =>
  entry({ timestamp, blocks: [{ kind: 'tool_use', id: 't', name, input }] });

describe('imagesIn', () => {
  it('finds an image a shell command wrote', () => {
    const found = imagesIn([used('Bash', { command: 'npx playwright test --output shot.png' })], '/repo');
    expect(found).toEqual([{ path: '/repo/shot.png', name: 'shot.png', at: '2026-09-25T10:00:00.000Z', tool: 'Bash' }]);
  });

  it('keeps an absolute path as it is', () => {
    const found = imagesIn([used('Write', { file_path: '/tmp/out/login.png' })], '/repo');
    expect(found[0]?.path).toBe('/tmp/out/login.png');
  });

  it('recognises the usual image kinds', () => {
    const found = imagesIn([used('Bash', { command: 'a.png b.jpg c.jpeg d.webp e.txt f.ts' })], '/repo');
    expect(found.map((f) => f.name)).toEqual(['a.png', 'b.jpg', 'c.jpeg', 'd.webp']);
  });

  it('ignores the case of the extension', () => {
    expect(imagesIn([used('Bash', { command: 'SHOT.PNG' })], '/repo')[0]?.name).toBe('SHOT.PNG');
  });

  it('reports the newest first', () => {
    const found = imagesIn(
      [
        used('Bash', { command: 'old.png' }, '2026-09-25T10:00:00.000Z'),
        used('Bash', { command: 'new.png' }, '2026-09-25T12:00:00.000Z'),
      ],
      '/repo',
    );
    expect(found.map((f) => f.name)).toEqual(['new.png', 'old.png']);
  });

  it('mentions an image only once, however often it appears', () => {
    const found = imagesIn(
      [used('Bash', { command: 'shot.png' }), used('Write', { file_path: 'shot.png' })],
      '/repo',
    );
    expect(found).toHaveLength(1);
  });

  it('does not claim an image the session merely looked at', () => {
    expect(imagesIn([used('Read', { file_path: 'design/logo.png' })], '/repo')).toEqual([]);
    expect(imagesIn([used('Glob', { pattern: '*.png' })], '/repo')).toEqual([]);
  });

  it('counts the tools that can actually put a file on disk', () => {
    for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(imagesIn([used(tool, { command: 'out.png' })], '/repo')).toHaveLength(1);
    }
  });

  it('looks past quoting and punctuation', () => {
    const found = imagesIn([used('Bash', { command: 'open "screens/a b.png"; cp \'c.png\' /tmp' })], '/repo');
    expect(found.map((f) => f.name)).toContain('c.png');
  });

  it('ignores what the user typed and what tools answered, reporting only what a tool was asked to write', () => {
    const entries = [
      entry({ role: 'user', blocks: [{ kind: 'text', text: 'look at mock.png' }] }),
      entry({ blocks: [{ kind: 'tool_result', toolUseId: 't', text: 'wrote result.png', isError: false }] }),
    ];
    expect(imagesIn(entries, '/repo')).toEqual([]);
  });

  it('skips a url that happens to end in an image name', () => {
    const found = imagesIn([used('Bash', { command: 'curl https://example.com/logo.png' })], '/repo');
    expect(found).toEqual([]);
  });

  it('has nothing to say about a session that produced no images', () => {
    expect(imagesIn([used('Bash', { command: 'pnpm test' })], '/repo')).toEqual([]);
  });
});
