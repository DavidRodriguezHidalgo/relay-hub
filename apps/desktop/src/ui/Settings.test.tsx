import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from './Settings';

const base = {
  theme: 'dark' as const,
  onTheme: vi.fn(),
  allowAllActions: false,
  onAllowAllActions: vi.fn(),
  onClose: vi.fn(),
  error: null,
};

describe('Settings', () => {
  it('switches the theme', async () => {
    const onTheme = vi.fn();
    render(<Settings {...base} onTheme={onTheme} />);
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(onTheme).toHaveBeenCalledWith('light');
  });

  it('turns allowing everything on and off, and says what it covers', async () => {
    const onAllowAllActions = vi.fn();
    const { rerender } = render(<Settings {...base} onAllowAllActions={onAllowAllActions} />);
    const toggle = screen.getByRole('checkbox', { name: /Allow all actions/ });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(onAllowAllActions).toHaveBeenCalledWith(true);

    rerender(<Settings {...base} allowAllActions onAllowAllActions={onAllowAllActions} />);
    expect(screen.getByRole('checkbox', { name: /Allow all actions/ })).toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: /Allow all actions/ }));
    expect(onAllowAllActions).toHaveBeenLastCalledWith(false);
  });

  it('closes', async () => {
    const onClose = vi.fn();
    render(<Settings {...base} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('says why a change did not take, instead of leaving a dead control', () => {
    render(<Settings {...base} error="No handler registered for 'relay:setAllowAllActions'" />);
    expect(screen.getByRole('alert')).toHaveTextContent('relay:setAllowAllActions');
  });
});
