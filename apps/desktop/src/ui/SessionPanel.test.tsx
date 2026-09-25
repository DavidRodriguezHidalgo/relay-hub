import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelChoice, QueuedMessage } from '@relay/shared';
import type { Collision } from './collisions';
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
  devTools: true, watch: null, onWatch: vi.fn(), onUnwatch: vi.fn(), notice: null, commands: [] as Invocable[], heldElsewhere: null as 'busy' | 'idle' | null, onTakeOver: vi.fn(), onAside: vi.fn(), models: [] as ModelChoice[], queue: [] as QueuedMessage[], onSetModel: vi.fn(), collision: null as Collision | null, onNewWorktree: vi.fn(), onDismissCollision: vi.fn(),
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
    ['Always allow this kind', { kind: 'allow-pattern' }],
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
  it('offers to take over a session another Claude has open, and only acts on the second press', async () => {
    const onTakeOver = vi.fn();
    renderPanel({ heldElsewhere: 'busy', onTakeOver });
    await userEvent.click(screen.getByRole('button', { name: 'Take over' }));
    expect(onTakeOver).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /^Confirm/ }));
    expect(onTakeOver).toHaveBeenCalledTimes(1);
  });

  it('says nothing about taking over when nobody else has the session', () => {
    renderPanel({ heldElsewhere: null });
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument();
  });
  it('offers to take over even without the send box, since that is the only way through', () => {
    renderPanel({ heldElsewhere: 'idle', devTools: false });
    expect(screen.getByRole('button', { name: 'Take over' })).toBeInTheDocument();
  });
  it('says it is working while the session runs, and stops when it is idle', () => {
    const { rerender } = render(
      <SessionPanel {...base} entries={[]} liveEntries={[]} approvals={[]} state={{ state: 'running', error: null }} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('still thinking');
    rerender(<SessionPanel {...base} entries={[]} liveEntries={[]} approvals={[]} state={{ state: 'idle', error: null }} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('puts the path of a dropped image into the box, so the session can read it', () => {
    Object.assign(window, { relay: { pathForFile: (f: File) => `/shots/${f.name}` } });
    try {
      renderPanel();
      const box = screen.getByPlaceholderText('Send to this session (dev)');
      fireEvent.drop(box, { dataTransfer: { files: [new File(['x'], 'shot.png', { type: 'image/png' })], types: ['Files'] } });
      expect(box).toHaveValue('/shots/shot.png\n');
    } finally {
      Reflect.deleteProperty(window, 'relay');
    }
  });
});

describe('SessionPanel side questions', () => {
  it('sends /btw to the aside, not to the session, and clears the box', async () => {
    const onSend = vi.fn();
    const onAside = vi.fn();
    renderPanel({ onSend, onAside });
    const box = screen.getByPlaceholderText('Send to this session (dev)');
    await userEvent.click(box);
    await userEvent.keyboard('/btw why sqlite?{Enter}');
    expect(onAside).toHaveBeenCalledWith('why sqlite?');
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue('');
  });

  it('asks for the question when /btw is sent on its own', async () => {
    const onAside = vi.fn();
    renderPanel({ onAside });
    await userEvent.click(screen.getByPlaceholderText('Send to this session (dev)'));
    await userEvent.keyboard('/btw{Enter}');
    expect(onAside).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/question/i);
  });

  it('marks an aside as a side thread in the transcript', () => {
    const aside: LiveEntry = { ...entry('q1', 'why?'), role: 'user', origin: 'aside' };
    render(
      <SessionPanel {...base} entries={[]} liveEntries={[aside]} state={undefined} approvals={[]} />,
    );
    expect(screen.getByText('side thread')).toBeInTheDocument();
    expect(document.querySelector('li.entry--aside')).not.toBeNull();
  });
});

describe('SessionPanel model picker', () => {
  const models: ModelChoice[] = [
    { id: 'opus[1m]', name: 'Opus', description: 'Best for complex work', current: true },
    { id: 'sonnet', name: 'Sonnet', description: 'Efficient for routine tasks', current: false },
  ];

  it('offers the models when /model is typed, marking the one in use', async () => {
    renderPanel({ models });
    await userEvent.click(screen.getByPlaceholderText('Send to this session (dev)'));
    await userEvent.keyboard('/model ');
    const menu = await screen.findByRole('listbox');
    expect(menu).toHaveTextContent('Opus');
    expect(menu).toHaveTextContent('Sonnet');
    expect(menu.querySelector('[aria-current="true"]')?.textContent).toContain('Opus');
  });

  it('switches to the model picked, and never sends /model to the session', async () => {
    const onSetModel = vi.fn();
    const onSend = vi.fn();
    renderPanel({ models, onSetModel, onSend });
    const box = screen.getByPlaceholderText('Send to this session (dev)');
    await userEvent.click(box);
    await userEvent.keyboard('/model son');
    await userEvent.keyboard('{Enter}');
    expect(onSetModel).toHaveBeenCalledWith('sonnet');
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue('');
  });

  it('takes /model with a name directly, without going near the session', async () => {
    const onSetModel = vi.fn();
    const onSend = vi.fn();
    renderPanel({ models, onSetModel, onSend });
    await userEvent.click(screen.getByPlaceholderText('Send to this session (dev)'));
    await userEvent.keyboard('/model sonnet{Enter}');
    expect(onSetModel).toHaveBeenCalledWith('sonnet');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('says so when /model names a model that does not exist, rather than sending it on', async () => {
    const onSetModel = vi.fn();
    const onSend = vi.fn();
    renderPanel({ models, onSetModel, onSend });
    await userEvent.click(screen.getByPlaceholderText('Send to this session (dev)'));
    await userEvent.keyboard('/model gpt{Enter}');
    expect(onSetModel).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/no model/i);
  });

  it('still passes a command the session owns straight through', async () => {
    const onSend = vi.fn();
    renderPanel({ models, onSend });
    await userEvent.click(screen.getByPlaceholderText('Send to this session (dev)'));
    await userEvent.keyboard('/review 3497{Enter}');
    expect(onSend).toHaveBeenCalledWith('/review 3497', 'steer');
  });
});

describe('SessionPanel collisions', () => {
  const other = { ...session, id: 'b', title: 'Beta' };

  it('warns when another session is working in the same directory, and names it', () => {
    renderPanel({ collision: { kind: 'directory', cwd: '/repo', branch: 'feat/a', others: [other], key: 'k' } });
    const warning = screen.getByRole('alert');
    expect(warning).toHaveTextContent(/same directory/i);
    expect(warning).toHaveTextContent('Beta');
    expect(warning).toHaveTextContent('/repo');
  });

  it('offers a worktree as the way out', async () => {
    const onNewWorktree = vi.fn();
    renderPanel({ collision: { kind: 'directory', cwd: '/repo', branch: 'feat/a', others: [other], key: 'k' }, onNewWorktree });
    await userEvent.click(screen.getByRole('button', { name: /worktree/i }));
    expect(onNewWorktree).toHaveBeenCalled();
  });

  it('warns more mildly about sharing a branch from another directory', () => {
    renderPanel({ collision: { kind: 'branch', cwd: '/repo', branch: 'feat/a', others: [other], key: 'k' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/same branch/i);
  });

  it('says nothing when the session has the place to itself', () => {
    renderPanel({ collision: null });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('SessionPanel collision list', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...session, id: `s${i}`, title: `Session ${i}` }));

  it('names a few and counts the rest, rather than listing everything', () => {
    renderPanel({ collision: { kind: 'directory', cwd: '/repo', branch: null, others: many, key: 'k' } });
    const warning = screen.getByRole('alert');
    expect(warning).toHaveTextContent('Session 0, Session 1, Session 2 and 27 more');
    expect(warning).not.toHaveTextContent('Session 9');
  });

  it('can be dismissed', async () => {
    const onDismissCollision = vi.fn();
    renderPanel({ collision: { kind: 'directory', cwd: '/repo', branch: null, others: many, key: 'k' }, onDismissCollision });
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissCollision).toHaveBeenCalled();
  });
});

describe('SessionPanel instruction queue', () => {
  const msg = (over: Partial<QueuedMessage>): QueuedMessage => ({
    id: 'm1', text: 'do the thing', origin: 'user', at: '2026-09-25T10:00:00.000Z', state: 'pending', ...over,
  });

  it('shows what is still waiting to be answered, and who sent it', () => {
    renderPanel({ queue: [msg({ id: 'a' }), msg({ id: 'b', text: 'and this', origin: 'orchestrator' })] });
    expect(screen.getByText(/2 instructions waiting/)).toBeInTheDocument();
    expect(screen.getByText(/do the thing/)).toBeInTheDocument();
    expect(screen.getByText('orchestrator')).toBeInTheDocument();
  });

  it('keeps an instruction that was never answered on screen, marked as lost', () => {
    renderPanel({ queue: [msg({ id: 'a', state: 'done' }), msg({ id: 'b', text: 'lost one', state: 'dropped' })] });
    expect(screen.getByText(/never answered/)).toBeInTheDocument();
    expect(screen.getByText(/lost one/)).toBeInTheDocument();
  });

  it('says nothing once everything has been answered', () => {
    renderPanel({ queue: [msg({ id: 'a', state: 'done' })] });
    expect(screen.queryByText(/waiting to be answered/)).not.toBeInTheDocument();
    expect(screen.queryByText(/never answered/)).not.toBeInTheDocument();
  });
});
