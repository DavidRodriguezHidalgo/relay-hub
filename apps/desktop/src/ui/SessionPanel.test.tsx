import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Invocable, LiveEntry, PendingApproval, SessionSummary, TranscriptEntry } from '@relay/shared';
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
  devTools: true, watch: null, onWatch: vi.fn(), onUnwatch: vi.fn(), notice: null, commands: [] as Invocable[],
};

const commands = [
  { name: 'review', description: 'Review the diff', argumentHint: '[pr]' },
  { name: 'rebase-all', description: 'Rebase everything', argumentHint: '' },
  { name: 'superpowers:brainstorming', description: 'Explore intent first', argumentHint: '' },
];

function renderPanel(props: Partial<typeof base> = {}) {
  return render(
    <SessionPanel {...base} {...props} entries={[]} liveEntries={[]} state={undefined} approvals={[]} />,
  );
}
const box = () => screen.getByPlaceholderText('Send to this session (dev)');
/** Only the menu's own options: the delivery-mode select has options too. */
const options = () => within(screen.getByRole('listbox')).getAllByRole('option');

describe('SessionPanel', () => {
  it('shows the same running dot as the sidebar, so the panel alone says whether it is working', () => {
    const { rerender } = render(
      <SessionPanel {...base} entries={[]} liveEntries={[]} state={{ state: 'running', error: null }} approvals={[]} />,
    );
    expect(screen.getByLabelText('running')).toHaveClass('dot--running');
    rerender(
      <SessionPanel {...base} entries={[]} liveEntries={[]} state={undefined} approvals={[]} dot="elsewhere" />,
    );
    expect(screen.getByLabelText('running elsewhere')).toHaveClass('dot--elsewhere');
  });
});

describe('SessionPanel slash menu', () => {
  it('opens on "/" and lists every command, with its description', async () => {
    const user = userEvent.setup();
    renderPanel({ commands });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(box());
    await user.keyboard('/');
    expect(options().map((o) => o.textContent)).toEqual([
      '/review [pr]Review the diff',
      '/rebase-allRebase everything',
      '/superpowers:brainstormingExplore intent first',
    ]);
  });

  it('filters as the user keeps typing, and closes when nothing matches', async () => {
    const user = userEvent.setup();
    renderPanel({ commands });
    await user.click(box());
    await user.keyboard('/re');
    expect(options().map((o) => o.querySelector('.slash-menu__name')?.textContent)).toEqual(['/review [pr]', '/rebase-all']);
    await user.keyboard('b');
    expect(options()).toHaveLength(1);
    await user.keyboard('zzz');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('moves through the list with the arrow keys, keeping the first item selected to start', async () => {
    const user = userEvent.setup();
    renderPanel({ commands });
    await user.click(box());
    await user.keyboard('/');
    const selected = () => options().find((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected()).toHaveTextContent('/review');
    await user.keyboard('{ArrowDown}');
    expect(selected()).toHaveTextContent('/rebase-all');
    await user.keyboard('{ArrowUp}');
    expect(selected()).toHaveTextContent('/review');
    // the list does not run off either end
    await user.keyboard('{ArrowUp}');
    expect(selected()).toHaveTextContent('/review');
  });

  it.each(['{Enter}', '{Tab}'])('puts the chosen command in the box with %s, ready for arguments, without sending', async (key) => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    renderPanel({ commands, onSend });
    await user.click(box());
    await user.keyboard('/reb');
    await user.keyboard(key);
    expect(box()).toHaveValue('/rebase-all ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('picks the command the user clicks', async () => {
    const user = userEvent.setup();
    renderPanel({ commands });
    await user.click(box());
    await user.keyboard('/');
    await user.click(screen.getByText('/superpowers:brainstorming'));
    expect(box()).toHaveValue('/superpowers:brainstorming ');
  });

  it('closes on Escape and stays closed until the command is typed again', async () => {
    const user = userEvent.setup();
    renderPanel({ commands });
    await user.click(box());
    await user.keyboard('/re');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.keyboard('v');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.clear(box());
    await user.keyboard('/re');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('leaves a slash that is not a command alone', async () => {
    const user = userEvent.setup();
    renderPanel({ commands });
    await user.click(box());
    await user.keyboard('look in src/ui');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('sends the command as typed', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    renderPanel({ commands, onSend });
    await user.click(box());
    await user.keyboard('/review');
    await user.keyboard('{Enter}');
    await user.keyboard('3497');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('/review 3497', 'steer');
  });
});

describe('SessionPanel', () => {
  it('shows why a send failed inside the send box, which stays on screen', () => {
    render(
      <SessionPanel
        {...base}
        notice="Session a is open in another Claude process (pid 4034)"
        entries={[entry('e1', 'from file')]}
        liveEntries={[]}
        state={undefined}
        approvals={[]}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Session a is open in another Claude process (pid 4034)');
    expect(alert.closest('form')).toBe(screen.getByPlaceholderText('Send to this session (dev)').closest('form'));
  });

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

  it.each([
    ['Allow once', { kind: 'allow-once' }],
    ['Deny', { kind: 'deny' }],
    ['Allow this kind for this run', { kind: 'allow-pattern' }],
  ])('a pending approval offers "%s"', async (label, decision) => {
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
    await userEvent.click(screen.getByRole('button', { name: label }));
    expect(onDecide.mock.calls).toEqual([['ap1', decision]]);
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

  it("an approval card decides once, even when double-clicked", async () => {
    const onDecide = vi.fn();
    render(<SessionPanel {...base} onDecide={onDecide} entries={[]} liveEntries={[]} state={{ state: "waiting-approval", error: null }} approvals={[approval]} />);
    await userEvent.dblClick(screen.getByRole("button", { name: "Allow once" }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  });
  it('sends on Enter and starts a new line on Shift+Enter', async () => {
    const onSend = vi.fn();
    renderPanel({ onSend });
    const box = screen.getByPlaceholderText('Send to this session (dev)');
    await userEvent.click(box);
    await userEvent.keyboard('first{Shift>}{Enter}{/Shift}second');
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue('first\nsecond');
    await userEvent.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('first\nsecond', 'steer');
    expect(box).toHaveValue('');
  });

  it('will not send an empty box on Enter', async () => {
    const onSend = vi.fn();
    renderPanel({ onSend });
    await userEvent.click(screen.getByPlaceholderText('Send to this session (dev)'));
    await userEvent.keyboard('   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Enter takes the highlighted command while the menu is open, rather than sending', async () => {
    const onSend = vi.fn();
    renderPanel({ onSend, commands });
    const box = screen.getByPlaceholderText('Send to this session (dev)');
    await userEvent.click(box);
    await userEvent.keyboard('/rev{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue('/review ');
  });
});
