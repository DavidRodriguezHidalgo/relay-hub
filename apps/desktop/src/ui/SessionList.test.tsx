import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionSummary } from '@relay/shared';
import { SessionList } from './SessionList';

const s = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'x', filePath: '/f', cwd: '/c', cwdExists: true, repo: 'repo', branch: 'main', title: 'T',
  lastActivity: '2026-09-20T00:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null, continuedIn: null,
  context: null, isStale: false, ...over,
});

describe('SessionList', () => {
  it('renders repo headers and selects on click, without branch or PR taking the row', async () => {
    const onSelect = vi.fn();
    render(
      <SessionList
        sessions={[s({ id: 'a', title: 'Mileage', branch: 'feat/mileage', prNumber: 115760 }), s({ id: 'b', title: 'Stale one', isStale: true })]}
        selectedId={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole('heading', { name: 'repo' })).toBeInTheDocument();
    // the row is for what it is, how loaded and whether it is working; the branch and PR live in the panel
    expect(screen.queryByText('feat/mileage')).not.toBeInTheDocument();
    expect(screen.queryByText('#115760')).not.toBeInTheDocument();
    expect(screen.queryByText('Stale one')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Show stale'));
    expect(screen.getByText('Stale one')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Mileage'));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it("waiting and error look different in shape, not only colour", () => {
    const { container } = render(
      <SessionList sessions={[s({ id: "w", title: "W" }), s({ id: "e", title: "E" })]} selectedId={null} onSelect={vi.fn()}
        states={{ w: { state: "waiting-approval", error: null }, e: { state: "error", error: "x" } }} />,
    );
    expect(container.querySelector(".dot--waiting-approval")?.getAttribute("aria-label")).toBe("waiting for approval");
    expect(container.querySelector(".dot--error")?.getAttribute("aria-label")).toBe("error");
  });

  it("marks sessions busy or open in another Claude process, unless Relay itself is driving them", () => {
    const { container } = render(
      <SessionList
        sessions={[s({ id: "b", title: "B" }), s({ id: "i", title: "I" }), s({ id: "r", title: "R" })]}
        selectedId={null}
        onSelect={vi.fn()}
        states={{ r: { state: "running", error: null } }}
        external={{ b: "busy", i: "idle", r: "busy" }}
      />,
    );
    const label = (title: string) =>
      [...container.querySelectorAll(".session-row")].find((b) => b.textContent?.includes(title))!.querySelector(".dot")!.getAttribute("aria-label");
    expect(label("B")).toBe("running elsewhere");
    expect(label("I")).toBe("open elsewhere");
    expect(label("R")).toBe("running");
  });

  it("collapses a project group, shows its count, and remembers it", async () => {
    localStorage.clear();
    const list = [s({ id: "a", title: "Alpha", repo: "factorial" }), s({ id: "b", title: "Beta", repo: "factorial" }), s({ id: "c", title: "Gamma", repo: "other" })];
    const { unmount } = render(<SessionList sessions={list} selectedId={null} onSelect={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /factorial/ }));
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /factorial/ })).toHaveTextContent("2");
    expect(screen.getByText("Gamma")).toBeInTheDocument();
    unmount();
    render(<SessionList sessions={list} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /factorial/ }));
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it('shows on a collapsed group that something inside is running, so nothing is hidden by collapsing it', async () => {
    const user = userEvent.setup();
    render(
      <SessionList
        sessions={[s({ id: 'a', title: 'Alpha' }), s({ id: 'b', title: 'Beta' })]}
        selectedId={null}
        onSelect={vi.fn()}
        states={{ b: { state: 'running', error: null } }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /repo/i }));
    const header = screen.getByRole('button', { name: /repo/i });
    expect(within(header).getByLabelText('running')).toBeInTheDocument();
  });
});

describe('SessionList recency', () => {
  // group collapse and the show-all choice are remembered in storage; each case starts fresh
  beforeEach(() => localStorage.clear());

  const NOW = Date.parse('2026-09-25T12:00:00.000Z');
  const ago = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
  const many = (count: number, hours: number, prefix: string) =>
    Array.from({ length: count }, (_, i) => s({ id: `${prefix}${i}`, title: `${prefix}${i}`, lastActivity: ago(hours + i) }));

  it('shows recent work and says how much it is holding back', () => {
    render(
      <SessionList sessions={[...many(5, 1, 'recent'), ...many(3, 500, 'old')]} selectedId={null} onSelect={vi.fn()} now={NOW} />,
    );
    expect(screen.getByText('recent0')).toBeInTheDocument();
    expect(screen.queryByText('old0')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3 older sessions hidden/ })).toBeInTheDocument();
  });

  it('shows everything when asked, and offers the way back', async () => {
    const user = userEvent.setup();
    render(
      <SessionList sessions={[...many(5, 1, 'recent'), ...many(3, 500, 'old')]} selectedId={null} onSelect={vi.fn()} now={NOW} />,
    );
    await user.click(screen.getByRole('button', { name: /3 older sessions hidden/ }));
    expect(screen.getByText('old0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Showing all 8/ })).toBeInTheDocument();
  });

  it('counts one hidden session in the singular', () => {
    render(
      <SessionList sessions={[...many(5, 1, 'recent'), ...many(1, 500, 'old')]} selectedId={null} onSelect={vi.fn()} now={NOW} />,
    );
    expect(screen.getByRole('button', { name: /1 older session hidden/ })).toBeInTheDocument();
  });

  it('keeps an old session that is still working', () => {
    render(
      <SessionList
        sessions={[...many(5, 1, 'recent'), s({ id: 'busy', title: 'busy', lastActivity: ago(900) })]}
        selectedId={null}
        onSelect={vi.fn()}
        states={{ busy: { state: 'running', error: null } }}
        now={NOW}
      />,
    );
    expect(screen.getByText('busy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /hidden/ })).not.toBeInTheDocument();
  });

  it('searches beyond the recent window', async () => {
    const user = userEvent.setup();
    render(
      <SessionList sessions={[...many(5, 1, 'recent'), ...many(3, 500, 'old')]} selectedId={null} onSelect={vi.fn()} now={NOW} />,
    );
    await user.type(screen.getByPlaceholderText('Search sessions'), 'old1');
    expect(screen.getByText('old1')).toBeInTheDocument();
  });

  it('shows whatever it was given above the list', () => {
    render(
      <SessionList sessions={[]} selectedId={null} onSelect={vi.fn()} header={<p>todo list here</p>} now={NOW} />,
    );
    expect(screen.getByText('todo list here')).toBeInTheDocument();
  });
});

describe('SessionList row at a glance', () => {
  beforeEach(() => localStorage.clear());
  const use = (percent: number) => ({ tokens: percent * 2000, limit: 200_000, percent, model: 'claude-opus-5', at: null });

  it('shows how loaded a session is, marked approximate', () => {
    render(<SessionList sessions={[s({ id: 'a', title: 'Mileage', context: use(42) })]} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText('~42%')).toBeInTheDocument();
  });

  it('marks a nearly full session so it stands out from the rest', () => {
    const { container } = render(
      <SessionList sessions={[s({ id: 'a', context: use(92) })]} selectedId={null} onSelect={vi.fn()} />,
    );
    expect(container.querySelector('.session-row__context--full')).not.toBeNull();
  });

  it('says nothing about context for a session that never called the model', () => {
    render(<SessionList sessions={[s({ id: 'a', context: null })]} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.queryByText(/~\d+%/)).not.toBeInTheDocument();
  });

  it('stays quiet for an idle session, naming only states worth noticing', () => {
    render(<SessionList sessions={[s({ id: 'a' })]} selectedId={null} onSelect={vi.fn()} states={{ a: { state: 'idle', error: null } }} />);
    expect(screen.queryByText('idle')).not.toBeInTheDocument();
  });

  it('names the state when a session is working or waiting', () => {
    render(
      <SessionList
        sessions={[s({ id: 'a' }), s({ id: 'b' })]}
        selectedId={null}
        onSelect={vi.fn()}
        states={{ a: { state: 'running', error: null }, b: { state: 'waiting-approval', error: null } }}
      />,
    );
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('waiting for approval')).toBeInTheDocument();
  });

  it('offers Stop on a working row and stops that session', async () => {
    const onInterrupt = vi.fn();
    render(
      <SessionList
        sessions={[s({ id: 'a', title: 'Mileage' })]}
        selectedId={null}
        onSelect={vi.fn()}
        states={{ a: { state: 'running', error: null } }}
        onInterrupt={onInterrupt}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Stop Mileage' }));
    expect(onInterrupt).toHaveBeenCalledWith('a');
  });

  it('offers no Stop on a session that is not working', () => {
    render(
      <SessionList sessions={[s({ id: 'a' })]} selectedId={null} onSelect={vi.fn()} states={{ a: { state: 'idle', error: null } }} onInterrupt={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: /^stop /i })).not.toBeInTheDocument();
  });
});
