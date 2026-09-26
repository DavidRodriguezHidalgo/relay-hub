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

  it("skips entries with nothing to show (thinking-only frames), so no empty cards appear", () => {
    const thinkingOnly: TranscriptEntry = {
      uuid: "t1", role: "assistant", timestamp: "2026-09-20T10:00:09.000Z", isSidechain: false, isMeta: false,
      blocks: [{ kind: "thinking" }],
    };
    const { container } = render(<TranscriptView entries={[thinkingOnly, entries[0]!]} hideSidechain />);
    expect(container.querySelectorAll("li.entry")).toHaveLength(1);
  });

  it("keeps a long single-line tool result to a short summary and puts the full text in the body", () => {
    const long = JSON.stringify({ session: { id: "x".repeat(300) } });
    const result: TranscriptEntry = {
      uuid: "r1", role: "user", timestamp: "2026-09-20T10:00:09.000Z", isSidechain: false, isMeta: false,
      blocks: [{ kind: "tool_result", toolUseId: "t", text: long, isError: false }],
    };
    const { container } = render(<TranscriptView entries={[result]} hideSidechain />);
    const summary = container.querySelector("summary")!;
    expect(summary.textContent!.length).toBeLessThanOrEqual(121);
    expect(summary.textContent!.endsWith("…")).toBe(true);
    expect(container.querySelector("pre")!.textContent).toBe(long);
  });
});

describe('TranscriptView api errors', () => {
  const failed: TranscriptEntry = {
    uuid: 'e1', role: 'assistant', timestamp: '2026-09-26T14:18:34.000Z', isSidechain: false, isMeta: false,
    apiError: 'authentication_failed',
    blocks: [{ kind: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }],
  };

  it('draws a failed request as an error, not as a reply, and says what to do', () => {
    const { container } = render(<TranscriptView entries={[failed]} hideSidechain />);
    expect(container.querySelector('.entry--error')).not.toBeNull();
    expect(screen.getByText('request failed')).toBeInTheDocument();
    expect(screen.getByText(/\/login/)).toBeInTheDocument();
  });

  it('shows only the message when it has no advice for that failure', () => {
    render(<TranscriptView entries={[{ ...failed, apiError: 'overloaded', blocks: [{ kind: 'text', text: 'Overloaded' }] }]} hideSidechain />);
    expect(screen.getByText('Overloaded')).toBeInTheDocument();
    expect(screen.queryByText(/\/login/)).not.toBeInTheDocument();
  });
});
