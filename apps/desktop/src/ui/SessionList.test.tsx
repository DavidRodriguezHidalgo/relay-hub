import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionSummary } from '@relay/shared';
import { SessionList } from './SessionList';

const s = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'x', filePath: '/f', cwd: '/c', cwdExists: true, repo: 'repo', branch: 'main', title: 'T',
  lastActivity: '2026-09-20T00:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null, continuedIn: null,
  isStale: false, ...over,
});

describe('SessionList', () => {
  it('renders repo headers, rows with branch and PR badge, and selects on click', async () => {
    const onSelect = vi.fn();
    render(
      <SessionList
        sessions={[s({ id: 'a', title: 'Mileage', branch: 'feat/mileage', prNumber: 115760 }), s({ id: 'b', title: 'Stale one', isStale: true })]}
        selectedId={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole('heading', { name: 'repo' })).toBeInTheDocument();
    expect(screen.getByText('feat/mileage')).toBeInTheDocument();
    expect(screen.getByText('#115760')).toBeInTheDocument();
    expect(screen.queryByText('Stale one')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Show stale'));
    expect(screen.getByText('Stale one')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Mileage'));
    expect(onSelect).toHaveBeenCalledWith('a');
  });
});
