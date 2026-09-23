import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PendingApproval, SessionSummary } from '@relay/shared';
import { ApprovalsDrawer } from './ApprovalsDrawer';

const s = (id: string, title: string): SessionSummary => ({
  id, filePath: '/f', cwd: '/c', cwdExists: true, repo: 'repo', branch: 'main', title,
  lastActivity: '2026-09-20T00:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null, continuedIn: null,
  isStale: false,
});
const ap = (id: string, sessionId: string, summary: string): PendingApproval => ({
  id, sessionId, toolName: 'Bash', input: { command: summary }, summary, reason: 'destructive-git', cwd: '/c',
  createdAt: '2026-09-23T00:00:00.000Z',
});

describe('ApprovalsDrawer', () => {
  it('lists approvals across sessions with their session title and opens a session', async () => {
    const onOpen = vi.fn();
    const onDecide = vi.fn();
    render(
      <ApprovalsDrawer
        approvals={[ap('1', 'a', 'git push -f'), ap('2', 'b', 'git clean -fd')]}
        sessions={[s('a', 'Alpha'), s('b', 'Beta')]}
        onDecide={onDecide}
        onOpenSession={onOpen}
      />,
    );
    expect(screen.getByText('2 approvals pending')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(onOpen).toHaveBeenCalledWith('b');
    await userEvent.click(screen.getAllByRole('button', { name: 'Deny' })[0]!);
    expect(onDecide).toHaveBeenCalledWith('1', { kind: 'deny' });
  });

  it('renders nothing when there are no approvals', () => {
    const { container } = render(
      <ApprovalsDrawer approvals={[]} sessions={[]} onDecide={vi.fn()} onOpenSession={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
