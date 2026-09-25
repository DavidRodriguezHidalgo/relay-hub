import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionSummary, Todo } from '@relay/shared';
import { TodoList } from './TodoList';

const todo = (over: Partial<Todo>): Todo => ({
  id: 't1', title: 'Activity log on vacancies', notes: '', project: '/repo', branch: null,
  sessionId: null, done: false, createdAt: '2026-09-25T10:00:00.000Z', launchedAt: null, ...over,
});

const session = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 's1', filePath: '/f', cwd: '/c', cwdExists: true, repo: 'repo', branch: 'feat/vacancies',
  title: 'T', lastActivity: '2026-09-25T10:00:00.000Z', messageCount: 1, prNumber: null,
  prUrl: null, continuedIn: null, context: null, isStale: false, ...over,
});

function setup(over: Partial<Parameters<typeof TodoList>[0]> = {}) {
  const props = {
    todos: [todo({})],
    sessions: [] as SessionSummary[],
    projects: [{ name: 'repo', root: '/repo', sessions: 2 }],
    states: {},
    external: {},
    onCreate: vi.fn().mockResolvedValue(undefined),
    onUpdate: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onLaunch: vi.fn().mockResolvedValue(undefined),
    onAttach: vi.fn().mockResolvedValue({ mode: 'steer' }),
    onDetach: vi.fn().mockResolvedValue(undefined),
    onOpenSession: vi.fn(),
    ...over,
  };
  render(<TodoList {...props} />);
  return props;
}

describe('TodoList', () => {
  it('adds work you type in', async () => {
    const user = userEvent.setup();
    const props = setup({ todos: [] });
    await user.type(screen.getByLabelText('What needs doing'), 'Fix the mileage rate{Enter}');
    expect(props.onCreate).toHaveBeenCalledWith({ title: 'Fix the mileage rate' });
  });

  it('does not add an empty todo', async () => {
    const user = userEvent.setup();
    const props = setup({ todos: [] });
    await user.type(screen.getByLabelText('What needs doing'), '   {Enter}');
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it('offers to start a session for a todo that has none yet', () => {
    setup();
    expect(screen.getByRole('button', { name: /start a session/i })).toBeEnabled();
  });

  it('explains the list rather than showing a bare box when there is no work', () => {
    setup({ todos: [] });
    expect(screen.getByText(/can be handed to a Claude session/i)).toBeInTheDocument();
  });

  it('names itself, so it is not read as another search box', () => {
    setup({ todos: [] });
    expect(screen.getByRole('heading', { name: 'Work to do' })).toBeInTheDocument();
  });

  it('launches the todo it was asked to', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole('button', { name: /start a session/i }));
    expect(props.onLaunch).toHaveBeenCalledWith('t1');
  });

  it('says what is missing instead of a dead button when no project is chosen', async () => {
    const user = userEvent.setup();
    setup({ todos: [todo({ project: null })] });
    const ask = screen.getByRole('button', { name: /choose a project first/i });
    expect(screen.queryByRole('button', { name: /start a session/i })).not.toBeInTheDocument();
    await user.click(ask);
    expect(screen.getByLabelText('Project')).toBeInTheDocument();
  });

  it('shows the branch and live state of the session a todo became, not a slot number', () => {
    setup({
      todos: [todo({ sessionId: 's1' })],
      sessions: [session({ id: 's1', branch: 'feat/vacancies' })],
      states: { s1: { state: 'running', error: null } },
    });
    expect(screen.getByText('feat/vacancies')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.queryByText(/slot/i)).not.toBeInTheDocument();
  });

  it('opens the session a todo became', async () => {
    const user = userEvent.setup();
    const props = setup({ todos: [todo({ sessionId: 's1' })], sessions: [session({ id: 's1' })] });
    await user.click(screen.getByRole('button', { name: /feat\/vacancies/ }));
    expect(props.onOpenSession).toHaveBeenCalledWith('s1');
  });

  it('says so when the session a todo became has gone', () => {
    setup({ todos: [todo({ sessionId: 'vanished' })], sessions: [] });
    expect(screen.getByText(/session is gone/i)).toBeInTheDocument();
  });

  it('ticks work off', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole('checkbox', { name: /activity log/i }));
    expect(props.onUpdate).toHaveBeenCalledWith('t1', { done: true });
  });

  it('keeps the context you wrote for a todo', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole('button', { name: /activity log/i }));
    const notes = screen.getByLabelText('Context');
    await user.type(notes, 'what done looks like');
    await user.tab();
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith('t1', { notes: 'what done looks like' }));
  });

  it('removes a todo', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole('button', { name: /activity log/i }));
    await user.click(screen.getByRole('button', { name: /remove/i }));
    expect(props.onDelete).toHaveBeenCalledWith('t1');
  });

  it('reports why a launch failed instead of failing silently', async () => {
    const user = userEvent.setup();
    setup({ onLaunch: vi.fn().mockRejectedValue(new Error('no worktree for you')) });
    await user.click(screen.getByRole('button', { name: /start a session/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no worktree for you');
  });

  it('says nothing at all when there is no work, rather than showing an empty frame', () => {
    setup({ todos: [] });
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('TodoList handing work to a session already open', () => {
  const open = (over: Partial<SessionSummary>) => session({ id: 'open1', title: 'Mileage work', branch: 'feat/mileage', ...over });

  it('offers sending to an existing session beside starting a new one', () => {
    setup({ sessions: [open({})] });
    expect(screen.getByRole('button', { name: /start a session/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send to a session/i })).toBeInTheDocument();
  });

  it('identifies each session by title, branch and what it is doing', async () => {
    const user = userEvent.setup();
    setup({ sessions: [open({})], states: { open1: { state: 'running', error: null } } });
    await user.click(screen.getByRole('button', { name: /send to a session/i }));
    const picker = screen.getByLabelText('Session to send it to');
    expect(picker).toHaveTextContent('Mileage work');
    expect(picker).toHaveTextContent('feat/mileage');
    expect(picker).toHaveTextContent('running');
  });

  it('says it will queue behind a turn that is already running', async () => {
    const user = userEvent.setup();
    setup({ sessions: [open({})], states: { open1: { state: 'running', error: null } } });
    await user.click(screen.getByRole('button', { name: /send to a session/i }));
    await user.selectOptions(screen.getByLabelText('Session to send it to'), 'open1');
    expect(screen.getByText(/queued behind/i)).toBeInTheDocument();
  });

  it('says it will start now when the session is idle', async () => {
    const user = userEvent.setup();
    setup({ sessions: [open({})], states: { open1: { state: 'idle', error: null } } });
    await user.click(screen.getByRole('button', { name: /send to a session/i }));
    await user.selectOptions(screen.getByLabelText('Session to send it to'), 'open1');
    expect(screen.getByText(/start(s)? (it )?now|straight away/i)).toBeInTheDocument();
  });

  it('refuses a session another process is holding, and says why', async () => {
    const user = userEvent.setup();
    setup({ sessions: [open({})], external: { open1: 'busy' } });
    await user.click(screen.getByRole('button', { name: /send to a session/i }));
    await user.selectOptions(screen.getByLabelText('Session to send it to'), 'open1');
    expect(screen.getByText(/another process|take it over/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
  });

  it('attaches the item to the session that was picked', async () => {
    const user = userEvent.setup();
    const props = setup({ sessions: [open({})] });
    await user.click(screen.getByRole('button', { name: /send to a session/i }));
    await user.selectOptions(screen.getByLabelText('Session to send it to'), 'open1');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    expect(props.onAttach).toHaveBeenCalledWith('t1', 'open1');
  });

  it('will not hand the same item out twice: an attached item offers to detach instead', async () => {
    const user = userEvent.setup();
    const props = setup({ todos: [todo({ sessionId: 's1' })], sessions: [session({ id: 's1' })] });
    expect(screen.queryByRole('button', { name: /start a session/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send to a session/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /activity log/i }));
    await user.click(screen.getByRole('button', { name: /detach/i }));
    expect(props.onDetach).toHaveBeenCalledWith('t1');
  });

  it('says so when there is no session to send it to', async () => {
    const user = userEvent.setup();
    setup({ sessions: [] });
    await user.click(screen.getByRole('button', { name: /send to a session/i }));
    expect(screen.getByText(/no sessions? open/i)).toBeInTheDocument();
  });
});
