import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LiveEntry, PendingApproval, SessionSummary, TranscriptEntry } from '@relay/shared';
import { SessionPanel } from './SessionPanel';

const session: SessionSummary = {
  id: 'a', filePath: '/f', cwd: '/repo', cwdExists: true, repo: 'repo', branch: 'feat/a', title: 'Alpha',
  lastActivity: '2026-09-20T00:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null, continuedIn: null,
  isStale: false,
};
const entry = (uuid: string, text: string): TranscriptEntry => ({
  uuid, role: 'assistant', timestamp: '2026-09-20T00:00:00.000Z', isSidechain: false, isMeta: false,
  blocks: [{ kind: 'text', text }],
});
const live = (uuid: string, text: string): LiveEntry => ({ ...entry(uuid, text), origin: 'orchestrator' });
const approval: PendingApproval = {
  id: 'ap1', sessionId: 'a', toolName: 'Bash', input: { command: 'git push --force' }, summary: 'git push --force',
  reason: 'destructive-git', cwd: '/repo', createdAt: '2026-09-23T00:00:00.000Z',
};

const base = {
  session, showSidechain: false, onToggleSidechain: vi.fn(), onDecide: vi.fn(), onSend: vi.fn(), onInterrupt: vi.fn(),
  devTools: true, watch: null, onWatch: vi.fn(), onUnwatch: vi.fn(),
};

describe('SessionPanel', () => {
  it('shows state, merges live entries by uuid and tags their origin', () => {
    render(
      <SessionPanel
        {...base}
        entries={[entry('e1', 'from file')]}
        liveEntries={[live('e1', 'dup'), live('e2', 'streamed')]}
        state={{ state: 'running', error: null }}
        approvals={[]}
      />,
    );
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('from file')).toBeInTheDocument();
    expect(screen.queryByText('dup')).not.toBeInTheDocument();
    expect(screen.getByText('streamed')).toBeInTheDocument();
    expect(screen.getByText('orchestrator')).toBeInTheDocument();
  });

  it('renders pending approvals with three decisions', async () => {
    const onDecide = vi.fn();
    render(
      <SessionPanel
        {...base}
        onDecide={onDecide}
        entries={[]}
        liveEntries={[]}
        state={{ state: 'waiting-approval', error: null }}
        approvals={[approval]}
      />,
    );
    expect(screen.getByText('git push --force')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await userEvent.click(screen.getByRole('button', { name: 'Allow this kind for this run' }));
    expect(onDecide.mock.calls).toEqual([
      ['ap1', { kind: 'allow-once' }],
      ['ap1', { kind: 'deny' }],
      ['ap1', { kind: 'allow-pattern' }],
    ]);
  });

  it('dev send box sends with the chosen mode and can interrupt', async () => {
    const onSend = vi.fn();
    const onInterrupt = vi.fn();
    render(
      <SessionPanel
        {...base}
        onSend={onSend}
        onInterrupt={onInterrupt}
        entries={[]}
        liveEntries={[]}
        state={{ state: 'idle', error: null }}
        approvals={[]}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText('Send to this session (dev)'), 'add tests');
    await userEvent.selectOptions(screen.getByLabelText('Delivery'), 'queue');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('add tests', 'queue');
    await userEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('shows the error reason and hides the dev box when devTools is off', () => {
    render(
      <SessionPanel
        {...base}
        devTools={false}
        entries={[]}
        liveEntries={[]}
        state={{ state: 'error', error: 'session not found' }}
        approvals={[]}
      />,
    );
    expect(screen.getByText('session not found')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Send to this session (dev)')).not.toBeInTheDocument();
  });

  it('offers Watch PR, and shows the watch with its last check and error once active', async () => {
    const onWatch = vi.fn();
    const withPr = { ...session, prNumber: 42, prUrl: 'https://github.com/o/r/pull/42' };
    const { rerender } = render(
      <SessionPanel {...base} session={withPr} onWatch={onWatch} entries={[]} liveEntries={[]} state={undefined} approvals={[]} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Watch PR' }));
    expect(onWatch).toHaveBeenCalled();
    const onUnwatch = vi.fn();
    rerender(
      <SessionPanel
        {...base}
        session={withPr}
        onUnwatch={onUnwatch}
        entries={[]}
        liveEntries={[]}
        state={undefined}
        approvals={[]}
        watch={{
          id: 'w1', sessionId: 'a', repo: 'o/r', prNumber: 42, prUrl: 'u', active: true, createdAt: 'x',
          lastPolledAt: '2026-09-23T12:00:00.000Z', lastError: 'gh: offline',
        }}
      />,
    );
    expect(screen.getByText(/Watching PR #42/)).toBeInTheDocument();
    expect(screen.getByText('gh: offline')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Watch PR' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop watching' }));
    expect(onUnwatch).toHaveBeenCalledWith('w1');
  });
});
