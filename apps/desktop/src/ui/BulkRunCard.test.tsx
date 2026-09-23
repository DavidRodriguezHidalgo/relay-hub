import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BulkRun } from '@relay/shared';
import { BulkRunCard } from './BulkRunCard';

const run = (over: Partial<BulkRun> = {}): BulkRun => ({
  id: 'r1', createdAt: '2026-09-23T12:00:00.000Z', mode: 'steer', status: 'proposed',
  rows: [
    { sessionId: 'a', title: 'Mileage', branch: 'feat/mileage', prompt: 'rebase onto main', status: 'proposed', detail: null },
    { sessionId: 'b', title: 'OCR', branch: 'feat/ocr', prompt: 'rebase onto main', status: 'proposed', detail: null },
  ],
  ...over,
});

describe('BulkRunCard', () => {
  it('lets the user untick rows and confirms only the ticked ones', async () => {
    const onConfirm = vi.fn();
    render(<BulkRunCard run={run()} onConfirm={onConfirm} onCancel={vi.fn()} />);
    expect(screen.getByText('Plan: 2 sessions')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('OCR'));
    await userEvent.click(screen.getByRole('button', { name: 'Run on 1 session' }));
    expect(onConfirm).toHaveBeenCalledWith(['a']);
  });

  it('disables run when nothing is ticked, and cancel calls back', async () => {
    const onCancel = vi.fn();
    render(<BulkRunCard run={run()} onConfirm={vi.fn()} onCancel={onCancel} />);
    await userEvent.click(screen.getByLabelText('Mileage'));
    await userEvent.click(screen.getByLabelText('OCR'));
    expect(screen.getByRole('button', { name: 'Run on 0 sessions' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows progress without controls once running', () => {
    render(
      <BulkRunCard
        run={run({
          status: 'running',
          rows: [
            { sessionId: 'a', title: 'Mileage', branch: null, prompt: 'p', status: 'done', detail: 'Rebased cleanly.' },
            { sessionId: 'b', title: 'OCR', branch: null, prompt: 'p', status: 'error', detail: 'conflict in a.ts' },
          ],
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('running · 1/2 done, 1 error')).toBeInTheDocument();
    expect(screen.getByText('Rebased cleanly.')).toBeInTheDocument();
    expect(screen.getByText('conflict in a.ts')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
