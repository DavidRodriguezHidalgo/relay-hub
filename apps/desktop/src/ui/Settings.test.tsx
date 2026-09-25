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
  update: null,
  checkingUpdate: false,
  onCheckForUpdate: vi.fn(),
  downloadedTo: null,
  downloading: false,
  downloadError: null,
  onDownloadUpdate: vi.fn(),
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
  it('checks for updates on request and says where the app stands', async () => {
    const onCheckForUpdate = vi.fn();
    const { rerender } = render(<Settings {...base} onCheckForUpdate={onCheckForUpdate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(onCheckForUpdate).toHaveBeenCalled();

    const done = { current: '0.1.0', latest: '0.1.0', newer: false, url: 'u', notes: null, publishedAt: null, assetUrl: null, assetName: null, error: null };
    rerender(<Settings {...base} update={done} />);
    expect(screen.getByRole('status')).toHaveTextContent('up to date');
    expect(screen.getByText(/Relay Hub 0\.1\.0/)).toBeInTheDocument();

    rerender(<Settings {...base} update={{ ...done, latest: '0.2.0', newer: true, notes: '- faster' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Version 0.2.0 is available');
    expect(screen.getByRole('link', { name: 'Open the release' })).toHaveAttribute('target', '_blank');
    expect(screen.getByText('- faster')).toBeInTheDocument();

    rerender(<Settings {...base} update={{ ...done, latest: null }} />);
    expect(screen.getByRole('status')).toHaveTextContent('No release has been published yet');

    rerender(<Settings {...base} update={{ ...done, error: 'GitHub answered 403' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t check: GitHub answered 403');
  });
});

describe('Settings update button', () => {
  const offered = {
    current: '0.1.0', latest: '0.2.0', newer: true, url: 'https://github.com/o/r/releases/tag/v0.2.0',
    notes: '- faster', publishedAt: null, assetUrl: 'https://x/relay.zip', assetName: 'Relay-0.2.0.zip', error: null,
  };

  it('offers the download, shows the version on offer and what is new', async () => {
    const onDownloadUpdate = vi.fn();
    render(<Settings {...base} update={offered} onDownloadUpdate={onDownloadUpdate} />);
    expect(screen.getByRole('status')).toHaveTextContent('Version 0.2.0 is available');
    expect(screen.getByText('- faster')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Download the new version' }));
    expect(onDownloadUpdate).toHaveBeenCalled();
  });

  it('says where the build landed and that it cannot replace itself', () => {
    render(<Settings {...base} update={offered} downloadedTo="/Users/me/Downloads/Relay-0.2.0.zip" />);
    const done = screen.getAllByRole('status').map((n) => n.textContent).join(' ');
    expect(done).toContain('/Users/me/Downloads/Relay-0.2.0.zip');
    expect(done).toMatch(/cannot replace itself while running/);
  });

  it('reports a download that failed rather than looking like it worked', () => {
    render(<Settings {...base} update={offered} downloadError="the download answered 404" />);
    expect(screen.getByRole('alert')).toHaveTextContent('answered 404');
  });

  it('says so when the release has no build attached, instead of a button that does nothing', () => {
    render(<Settings {...base} update={{ ...offered, assetUrl: null, assetName: null }} />);
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    expect(screen.getByText(/no build attached/)).toBeInTheDocument();
  });

  it('always says which version is running', () => {
    render(<Settings {...base} update={{ ...offered, newer: false, latest: '0.1.0' }} />);
    expect(screen.getByText(/Relay Hub 0\.1\.0/)).toBeInTheDocument();
  });
});
