import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { WorkingLine } from './WorkingLine';

describe('WorkingLine', () => {
  afterEach(() => vi.useRealTimers());

  it('counts the seconds it has been working', () => {
    vi.useFakeTimers();
    render(<WorkingLine word="Infusing" tip="press /" />);
    expect(screen.getByRole('status')).toHaveTextContent('Infusing… (0s · still thinking)');
    act(() => vi.advanceTimersByTime(12_000));
    expect(screen.getByRole('status')).toHaveTextContent('Infusing… (12s · still thinking)');
  });

  it('says something, and offers a tip, when left to choose for itself', () => {
    render(<WorkingLine />);
    expect(screen.getByRole('status').textContent).toMatch(/\w+… \(0s · still thinking\)/);
    expect(screen.getByText(/^Tip: /)).toBeInTheDocument();
  });
});
