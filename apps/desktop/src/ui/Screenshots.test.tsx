import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Screenshot } from '@relay/shared';
import { Screenshots } from './Screenshots';

const shot = (over: Partial<Screenshot>): Screenshot => ({
  path: '/repo/shot.png', name: 'shot.png', at: '2026-09-25T10:00:00.000Z', tool: 'Bash',
  dataUrl: 'data:image/png;base64,AAA', ...over,
});

describe('Screenshots', () => {
  it('takes only one line until it is asked for, so the chat keeps the room', () => {
    render(<Screenshots shots={[shot({}), shot({ path: '/repo/b.png', name: 'b.png' })]} />);
    expect(screen.getByRole('button', { name: /2 images produced/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('counts a single image in the singular', () => {
    render(<Screenshots shots={[shot({})]} />);
    expect(screen.getByRole('button', { name: /1 image produced/ })).toBeInTheDocument();
  });

  it('shows the images when opened, and hides them again', async () => {
    const user = userEvent.setup();
    render(<Screenshots shots={[shot({})]} />);
    await user.click(screen.getByRole('button', { name: /1 image produced/ }));
    expect(screen.getByRole('img', { name: 'shot.png' })).toHaveAttribute('src', 'data:image/png;base64,AAA');
    await user.click(screen.getByRole('button', { name: /1 image produced/ }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('credits the tool that wrote it, so it reads as the agent output it is', async () => {
    const user = userEvent.setup();
    render(<Screenshots shots={[shot({ tool: 'Bash' })]} />);
    await user.click(screen.getByRole('button', { name: /produced/ }));
    expect(screen.getByText(/Bash/)).toBeInTheDocument();
  });

  it('names a file it could not inline rather than showing a broken image', async () => {
    const user = userEvent.setup();
    render(<Screenshots shots={[shot({ dataUrl: null })]} />);
    await user.click(screen.getByRole('button', { name: /produced/ }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/too large to show/)).toBeInTheDocument();
  });

  it('stays out of the way entirely when the session produced nothing', () => {
    const { container } = render(<Screenshots shots={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
