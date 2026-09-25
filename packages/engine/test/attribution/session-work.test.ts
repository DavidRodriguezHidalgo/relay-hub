import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '@relay/shared';
import { attribute, filesOf, filesWrittenIn, spanOf } from '../../src/attribution/session-work';

const used = (name: string, input: unknown, timestamp = '2026-09-25T10:00:00.000Z'): TranscriptEntry => ({
  uuid: 'u', role: 'assistant', timestamp, isSidechain: false, isMeta: false,
  blocks: [{ kind: 'tool_use', id: 't', name, input }],
});

const commit = (sha: string, files: string[], at = '2026-09-25T10:30:00.000Z') => ({
  sha, subject: `work ${sha}`, at, files,
});

describe('filesWrittenIn', () => {
  it('takes the file each writing tool names', () => {
    const files = filesWrittenIn(
      [used('Write', { file_path: '/repo/a.ts' }), used('Edit', { file_path: '/repo/b.ts' })],
      '/repo',
    );
    expect(files).toEqual(['a.ts', 'b.ts']);
  });

  it('reads a relative path against the session directory', () => {
    expect(filesWrittenIn([used('Write', { file_path: 'src/a.ts' })], '/repo')).toEqual(['src/a.ts']);
  });

  it('does not claim a file the session only read or searched', () => {
    const entries = [used('Read', { file_path: '/repo/a.ts' }), used('Grep', { pattern: 'x', path: '/repo' })];
    expect(filesWrittenIn(entries, '/repo')).toEqual([]);
  });

  it('claims nothing from a shell command, because a shell line cannot be attributed honestly', () => {
    expect(filesWrittenIn([used('Bash', { command: 'echo hi > /repo/a.ts' })], '/repo')).toEqual([]);
  });

  it('ignores a file outside the session directory', () => {
    expect(filesWrittenIn([used('Write', { file_path: '/elsewhere/a.ts' })], '/repo')).toEqual([]);
  });

  it('names a file once however often it was edited', () => {
    const entries = [used('Edit', { file_path: '/repo/a.ts' }), used('Edit', { file_path: '/repo/a.ts' })];
    expect(filesWrittenIn(entries, '/repo')).toEqual(['a.ts']);
  });
});

describe('spanOf', () => {
  it('runs from the first entry to the last', () => {
    const span = spanOf([used('Write', {}, '2026-09-25T09:00:00.000Z'), used('Write', {}, '2026-09-25T11:00:00.000Z')]);
    expect(span).toEqual({ from: '2026-09-25T09:00:00.000Z', to: '2026-09-25T11:00:00.000Z' });
  });

  it('has no span for a session with nothing in it', () => {
    expect(spanOf([])).toEqual({ from: null, to: null });
  });
});

describe('attribute', () => {
  it('keeps a commit that touches a file this session wrote', () => {
    const kept = attribute([commit('a1', ['src/mileage.ts'])], ['src/mileage.ts']);
    expect(kept.map((c) => c.sha)).toEqual(['a1']);
  });

  it("drops work merged in from elsewhere, which touches other people's files", () => {
    const kept = attribute(
      [
        commit('mine', ['src/mileage.ts']),
        commit('theirs', ['app/graphql/schema.json']),
        commit('alsoTheirs', ['docs/analytics.md', '.github/workflows/ci.yml']),
      ],
      ['src/mileage.ts'],
    );
    expect(kept.map((c) => c.sha)).toEqual(['mine']);
  });

  it('claims nothing when the session wrote nothing, rather than claiming the branch', () => {
    expect(attribute([commit('a1', ['src/a.ts'])], [])).toEqual([]);
  });

  it('keeps a commit that touches one of several files the session wrote', () => {
    const kept = attribute([commit('a1', ['src/b.ts', 'unrelated.ts'])], ['src/a.ts', 'src/b.ts']);
    expect(kept.map((c) => c.sha)).toEqual(['a1']);
  });
});

describe('filesOf', () => {
  it('adds the files carried by the commits this session made', () => {
    const files = filesOf(['src/a.ts'], [commit('a1', ['src/a.ts', 'src/b.ts'])]);
    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('recovers work done in a worktree that has since been deleted', () => {
    // the session wrote one file where it was opened; the rest went to a worktree now gone,
    // and only the commit still names them
    const files = filesOf(
      ['src/mastra/tools/mileage-mutation.ts'],
      [commit('a1', ['src/mastra/tools/mileage-mutation.ts', 'src/mastra/tools/mileage-stash.ts', 'src/mastra/tools/mileage-questions.ts'])],
    );
    expect(files).toEqual([
      'src/mastra/tools/mileage-mutation.ts',
      'src/mastra/tools/mileage-questions.ts',
      'src/mastra/tools/mileage-stash.ts',
    ]);
  });

  it('names a file once when both the session and its commit have it', () => {
    expect(filesOf(['a.ts'], [commit('a1', ['a.ts'])])).toEqual(['a.ts']);
  });

  it('claims nothing extra when no commit was attributed', () => {
    expect(filesOf(['a.ts'], [])).toEqual(['a.ts']);
  });
});
