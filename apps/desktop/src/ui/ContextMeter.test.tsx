import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ContextUse } from '@relay/shared';
import { ContextMeter } from './ContextMeter';

const use = (over: Partial<ContextUse>): ContextUse => ({
  tokens: 100_000, limit: 200_000, percent: 50, model: 'claude-opus-5',
  at: '2026-09-25T10:00:00.000Z', ...over,
});

describe('ContextMeter', () => {
  it('shows the share of the window, marked as approximate', () => {
    render(<ContextMeter use={use({ percent: 50 })} />);
    expect(screen.getByText('~50% context')).toBeInTheDocument();
  });

  it('says the number is an estimate and where it comes from', () => {
    render(<ContextMeter use={use({ percent: 50 })} />);
    expect(screen.getByTitle(/approximate/i)).toBeInTheDocument();
    expect(screen.getByTitle(/100,000 of 200,000/)).toBeInTheDocument();
  });

  it('marks a session that is nearly full, since that changes what you do with it', () => {
    const { container } = render(<ContextMeter use={use({ percent: 92 })} />);
    expect(container.querySelector('.context--full')).not.toBeNull();
  });

  it('does not mark a session with room left', () => {
    const { container } = render(<ContextMeter use={use({ percent: 30 })} />);
    expect(container.querySelector('.context--full')).toBeNull();
  });

  it('shows nothing for a session that never called the model', () => {
    const { container } = render(<ContextMeter use={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
