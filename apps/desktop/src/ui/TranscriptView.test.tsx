import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TranscriptEntry } from '@relay/shared';
import { TranscriptView } from './TranscriptView';

const entries: TranscriptEntry[] = [
  { uuid: 'u1', role: 'user', timestamp: '2026-09-20T10:00:00.000Z', isSidechain: false, isMeta: false, blocks: [{ kind: 'text', text: 'add tests' }] },
  { uuid: 'a1', role: 'assistant', timestamp: '2026-09-20T10:00:05.000Z', isSidechain: false, isMeta: false, blocks: [
    { kind: 'thinking' },
    { kind: 'text', text: 'Looking.' },
    { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } },
  ] },
  { uuid: 'u2', role: 'user', timestamp: '2026-09-20T10:00:06.000Z', isSidechain: false, isMeta: false, blocks: [
    { kind: 'tool_result', toolUseId: 't1', text: 'line one\nline two', isError: false },
  ] },
  { uuid: 'm1', role: 'user', timestamp: '2026-09-20T10:00:07.000Z', isSidechain: false, isMeta: true, blocks: [{ kind: 'text', text: 'META' }] },
  { uuid: 's1', role: 'user', timestamp: '2026-09-20T10:00:08.000Z', isSidechain: true, isMeta: false, blocks: [{ kind: 'text', text: 'SIDE' }] },
];

describe('TranscriptView', () => {
  it('renders text, tool chips and collapsed results; hides meta and sidechain', () => {
    render(<TranscriptView entries={entries} hideSidechain />);
    expect(screen.getByText('add tests')).toBeInTheDocument();
    expect(screen.getByText('Looking.')).toBeInTheDocument();
    expect(screen.getByText(/Read \{"file_path":"\/a\.ts"\}/)).toBeInTheDocument();
    expect(screen.getByText('line one')).toBeInTheDocument();
    expect(screen.queryByText('META')).not.toBeInTheDocument();
    expect(screen.queryByText('SIDE')).not.toBeInTheDocument();
  });

  it('shows sidechain entries when asked', () => {
    render(<TranscriptView entries={entries} hideSidechain={false} />);
    expect(screen.getByText('SIDE')).toBeInTheDocument();
  });
});
