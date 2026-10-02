import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountUsage } from '@relay/shared';
import { UsageMeter } from './UsageMeter';

const usage = (percent: number, over: Partial<AccountUsage> = {}): AccountUsage => ({
  available: true,
  plan: 'team',
  checkedAt: '2026-10-02T08:30:00.000Z',
  windows: [{ kind: 'seven-day', percent, resetsAt: '2026-10-06T03:59:59.000Z' }],
  ...over,
});

const now = new Date('2026-10-02T08:30:00.000Z');

describe('UsageMeter', () => {
  it('stays out of the way while there is plenty of the allowance left', () => {
    const { container } = render(<UsageMeter usage={usage(26)} now={now} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('appears once enough is gone that it changes how you would spread the work', () => {
    render(<UsageMeter usage={usage(61)} now={now} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /61%/ })).toBeInTheDocument();
  });

  it('grows more insistent as the allowance runs down', () => {
    const { container, rerender } = render(<UsageMeter usage={usage(61)} now={now} onOpen={vi.fn()} />);
    expect(container.querySelector('.usage-pill--notable')).not.toBeNull();
    rerender(<UsageMeter usage={usage(85)} now={now} onOpen={vi.fn()} />);
    expect(container.querySelector('.usage-pill--tight')).not.toBeNull();
    rerender(<UsageMeter usage={usage(95)} now={now} onOpen={vi.fn()} />);
    expect(container.querySelector('.usage-pill--critical')).not.toBeNull();
  });

  it('says when the allowance comes back, which is the thing you act on', () => {
    render(<UsageMeter usage={usage(95)} now={now} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Tue/ })).toBeInTheDocument();
  });

  it('leads to the detail rather than trying to explain itself in the strip', async () => {
    const onOpen = vi.fn();
    render(<UsageMeter usage={usage(95)} now={now} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: /95%/ }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('shows nothing at all when Relay could not read the limits, rather than a reassuring zero', () => {
    const { container } = render(
      <UsageMeter usage={usage(0, { available: false, windows: [] })} now={now} onOpen={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing before the first answer has arrived', () => {
    const { container } = render(<UsageMeter usage={null} now={now} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
