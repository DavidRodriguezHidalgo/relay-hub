import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RelayApi, RunnerEvent, SessionSummary } from '@relay/shared';
import { App } from './App';

const s = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'x', filePath: '/f', cwd: '/c', cwdExists: true, repo: 'repo', branch: 'main', title: 'T',
  lastActivity: '2026-09-20T00:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null, continuedIn: null,
  isStale: false, ...over,
});

describe('App', () => {
  let listeners: Array<(sessions: SessionSummary[]) => void>;
  let relay: { [K in keyof RelayApi]: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    listeners = [];
    relay = {
      listSessions: vi.fn().mockResolvedValue([s({ id: 'a', title: 'Alpha' }), s({ id: 'b', title: 'Beta' })]),
      getTranscript: vi.fn().mockResolvedValue([]),
      onSessionsChanged: vi.fn((l: (sessions: SessionSummary[]) => void) => {
        listeners.push(l);
        return () => undefined;
      }),
      send: vi.fn().mockResolvedValue('msg-1'),
      interrupt: vi.fn().mockResolvedValue(undefined),
      decide: vi.fn().mockResolvedValue(undefined),
      runState: vi.fn().mockResolvedValue({ states: {}, approvals: [], bulkRuns: [], watches: [], gh: { state: 'ok' }, external: {} }),
      onRunnerEvent: vi.fn(() => () => undefined),
      orchestratorSend: vi.fn().mockResolvedValue('o-1'),
      orchestratorInterrupt: vi.fn().mockResolvedValue(undefined),
      orchestratorHistory: vi.fn().mockResolvedValue([]),
      bulkConfirm: vi.fn().mockResolvedValue(undefined),
      bulkCancel: vi.fn().mockResolvedValue(undefined),
      watchCreate: vi.fn(),
      watchDelete: vi.fn().mockResolvedValue(undefined),
      listProjects: vi.fn().mockResolvedValue([{ name: 'factorial', root: '/code/factorial', sessions: 2 }]),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'n1', cwd: '/code/factorial-worktrees/feat-x' }),
    };
    Object.assign(window, { relay });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'relay');
  });

  it('loads the orchestrator history, sends from the chat, and shows orchestrator entries only in the chat', async () => {
    let emit: ((e: RunnerEvent) => void) | null = null;
    relay.onRunnerEvent.mockImplementation((l: (e: RunnerEvent) => void) => {
      emit = l;
      return () => undefined;
    });
    render(<App />);
    await userEvent.click(await screen.findByText('Alpha'));
    expect(relay.orchestratorHistory).toHaveBeenCalledTimes(1);
    await userEvent.type(screen.getByPlaceholderText('Ask Relay…'), 'hello{Enter}');
    expect(relay.orchestratorSend).toHaveBeenCalledWith('hello');
    await act(async () => {
      emit!({
        type: 'entry',
        sessionId: 'orchestrator',
        entry: {
          uuid: 'o1', role: 'assistant', timestamp: '2026-09-23T00:00:00.000Z', isSidechain: false, isMeta: false,
          blocks: [{ kind: 'text', text: 'Two sessions are running.' }], origin: 'user',
        },
      });
    });
    expect(screen.getByLabelText('Orchestrator')).toHaveTextContent('Two sessions are running.');
    expect(screen.getByLabelText('Session panel')).not.toHaveTextContent('Two sessions are running.');
  });

  it('shows a proposed bulk run as a plan card and confirms it', async () => {
    let emit: ((e: RunnerEvent) => void) | null = null;
    relay.onRunnerEvent.mockImplementation((l: (e: RunnerEvent) => void) => {
      emit = l;
      return () => undefined;
    });
    render(<App />);
    await screen.findByText('Alpha');
    await act(async () => {
      emit!({
        type: 'bulk',
        run: {
          id: 'r1', createdAt: '2026-09-23T12:00:00.000Z', mode: 'steer', status: 'proposed',
          rows: [
            { sessionId: 'a', title: 'Alpha', branch: null, prompt: 'rebase', status: 'proposed', detail: null },
            { sessionId: 'b', title: 'Beta', branch: null, prompt: 'rebase', status: 'proposed', detail: null },
          ],
        },
      });
    });
    expect(screen.getByLabelText('Orchestrator')).toHaveTextContent('Plan: 2 sessions');
    await userEvent.click(screen.getByRole('button', { name: 'Run on 2 sessions' }));
    expect(relay.bulkConfirm).toHaveBeenCalledWith('r1', ['a', 'b']);
  });

  it('Watch PR asks the engine, shows a failure, and a gh outage shows a banner', async () => {
    let emit: ((e: RunnerEvent) => void) | null = null;
    relay.onRunnerEvent.mockImplementation((l: (e: RunnerEvent) => void) => {
      emit = l;
      return () => undefined;
    });
    relay.watchCreate.mockRejectedValue(new Error('No pull request found for session "Alpha" (branch main)'));
    render(<App />);
    await userEvent.click(await screen.findByText('Alpha'));
    await userEvent.click(screen.getByRole('button', { name: 'Watch PR' }));
    expect(relay.watchCreate).toHaveBeenCalledWith('a');
    expect(await screen.findByText(/No pull request found for session/)).toBeInTheDocument();
    await act(async () => {
      emit!({
        type: 'watch',
        watch: { id: 'w1', sessionId: 'b', repo: 'o/r', prNumber: 1, prUrl: 'u', active: true, createdAt: 'x', lastPolledAt: null, lastError: 'gh: not logged in' },
        gh: { state: 'unavailable', message: 'gh: not logged in' },
      });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('gh: not logged in');
  });

  it('a removed watch disappears from the panel and Watch PR comes back', async () => {
    let emit: ((e: RunnerEvent) => void) | null = null;
    relay.onRunnerEvent.mockImplementation((l: (e: RunnerEvent) => void) => {
      emit = l;
      return () => undefined;
    });
    render(<App />);
    await userEvent.click(await screen.findByText('Alpha'));
    await act(async () => {
      emit!({
        type: 'watch',
        watch: { id: 'w1', sessionId: 'a', repo: 'o/r', prNumber: 9, prUrl: 'u', active: true, createdAt: 'x', lastPolledAt: null, lastError: null },
        gh: { state: 'ok' },
      });
    });
    expect(screen.getByText(/Watching PR #9/)).toBeInTheDocument();
    await act(async () => {
      emit!({ type: 'watch-removed', watchId: 'w1', gh: { state: 'ok' } });
    });
    expect(screen.queryByText(/Watching PR #9/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch PR' })).toBeInTheDocument();
  });

  it('an event that arrives before the initial snapshot is not overwritten by it', async () => {
    let emit: ((e: RunnerEvent) => void) | null = null;
    relay.onRunnerEvent.mockImplementation((l: (e: RunnerEvent) => void) => {
      emit = l;
      return () => undefined;
    });
    let resolveSnapshot!: (v: unknown) => void;
    relay.runState.mockReturnValue(new Promise((r) => (resolveSnapshot = r)));
    render(<App />);
    await userEvent.click(await screen.findByText('Alpha'));
    await act(async () => {
      emit!({ type: 'state', sessionId: 'a', state: 'running', error: null });
    });
    await act(async () => {
      resolveSnapshot({ states: { a: { state: 'idle', error: null } }, approvals: [], bulkRuns: [], watches: [], gh: { state: 'ok' }, external: {} });
    });
    expect(screen.getByLabelText('Session panel')).toHaveTextContent('running');
  });

  it('keeps at most 500 live entries per session', async () => {
    let emit: ((e: RunnerEvent) => void) | null = null;
    relay.onRunnerEvent.mockImplementation((l: (e: RunnerEvent) => void) => {
      emit = l;
      return () => undefined;
    });
    render(<App />);
    await userEvent.click(await screen.findByText('Alpha'));
    await act(async () => {
      for (let i = 0; i < 520; i += 1) {
        emit!({ type: 'entry', sessionId: 'a', entry: { uuid: 'l' + i, role: 'assistant', timestamp: '2026-09-23T00:00:00.000Z', isSidechain: false, isMeta: false, blocks: [{ kind: 'text', text: 'line ' + i }], origin: 'user' } });
      }
    });
    expect(screen.queryByText('line 0')).not.toBeInTheDocument();
    expect(screen.getByText('line 519')).toBeInTheDocument();
  });

  it('New session opens the form and creates through the engine', async () => {
    render(<App />);
    await screen.findByText('Alpha');
    await userEvent.click(screen.getByRole('button', { name: 'New session' }));
    await userEvent.selectOptions(await screen.findByLabelText('Project'), '/code/factorial');
    await userEvent.type(screen.getByLabelText('Branch'), 'feat/x');
    await userEvent.type(screen.getByLabelText('First instruction'), 'Add a CSV export');
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));
    expect(relay.createSession).toHaveBeenCalledWith({ project: '/code/factorial', branch: 'feat/x', prompt: 'Add a CSV export' });
    expect(screen.queryByLabelText('Branch')).not.toBeInTheDocument();
  });

  it('re-fetches the transcript only when the selected session itself changed', async () => {
    render(<App />);
    await userEvent.click(await screen.findByText('Alpha'));
    expect(relay.getTranscript).toHaveBeenCalledTimes(1);

    // another session changes: no refetch
    await act(async () => {
      for (const l of listeners) l([s({ id: 'a', title: 'Alpha' }), s({ id: 'b', title: 'Beta', messageCount: 9 })]);
    });
    expect(relay.getTranscript).toHaveBeenCalledTimes(1);

    // the selected session grows: refetch
    await act(async () => {
      for (const l of listeners) l([s({ id: 'a', title: 'Alpha', messageCount: 2, lastActivity: '2026-09-21T00:00:00.000Z' }), s({ id: 'b', title: 'Beta' })]);
    });
    expect(relay.getTranscript).toHaveBeenCalledTimes(2);
  });

  it('appends runner entries for the selected session live', async () => {
    let emit: ((e: RunnerEvent) => void) | null = null;
    relay.onRunnerEvent.mockImplementation((l: (e: RunnerEvent) => void) => {
      emit = l;
      return () => undefined;
    });
    render(<App />);
    await userEvent.click(await screen.findByText('Alpha'));
    const liveEntry = (uuid: string, text: string) => ({
      uuid, role: 'assistant' as const, timestamp: '2026-09-23T00:00:00.000Z', isSidechain: false, isMeta: false,
      blocks: [{ kind: 'text' as const, text }], origin: 'user' as const,
    });
    await act(async () => {
      emit!({ type: 'entry', sessionId: 'a', entry: liveEntry('live1', 'streamed now') });
      emit!({ type: 'entry', sessionId: 'b', entry: liveEntry('live2', 'other session') });
      emit!({ type: 'state', sessionId: 'a', state: 'running', error: null });
    });
    expect(screen.getByText('streamed now')).toBeInTheDocument();
    expect(screen.queryByText('other session')).not.toBeInTheDocument();
    expect(screen.getAllByText('running').length).toBeGreaterThan(0);
  });

  it('opens a transcript scrolled to the bottom and follows updates unless the user scrolled up', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 });
    const entry = (uuid: string) => ({
      uuid, role: 'assistant' as const, timestamp: '2026-09-20T00:00:00.000Z', isSidechain: false, isMeta: false,
      blocks: [{ kind: 'text' as const, text: uuid }],
    });
    relay.getTranscript.mockResolvedValue([entry('e1')]);
    render(<App />);
    await userEvent.click(await screen.findByText('Alpha'));
    const panel = screen.getByLabelText('Session panel');
    await screen.findByText('e1');
    expect(panel.scrollTop).toBe(1000);

    // user scrolls up, then the session grows: position is kept
    panel.scrollTop = 100;
    fireEvent.scroll(panel);
    relay.getTranscript.mockResolvedValue([entry('e1'), entry('e2')]);
    await act(async () => {
      for (const l of listeners) l([s({ id: 'a', title: 'Alpha', messageCount: 2 }), s({ id: 'b', title: 'Beta' })]);
    });
    await screen.findByText('e2');
    expect(panel.scrollTop).toBe(100);

    // back at the bottom, the next update follows
    panel.scrollTop = 700;
    fireEvent.scroll(panel);
    relay.getTranscript.mockResolvedValue([entry('e1'), entry('e2'), entry('e3')]);
    await act(async () => {
      for (const l of listeners) l([s({ id: 'a', title: 'Alpha', messageCount: 3 }), s({ id: 'b', title: 'Beta' })]);
    });
    await screen.findByText('e3');
    expect(panel.scrollTop).toBe(1000);
  });
});
