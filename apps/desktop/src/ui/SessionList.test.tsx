import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionSummary } from '@relay/shared';
import { SessionList } from './SessionList';

const s = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'x', filePath: '/f', cwd: '/c', cwdExists: true, repo: 'repo', branch: 'main', title: 'T',
  lastActivity: '2026-09-20T00:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null, continuedIn: null,
  isStale: false, ...over,
});

describe('SessionList', () => {
  it('renders repo headers, rows with branch and PR badge, and selects on click', async () => {
    const onSelect = vi.fn();
    render(
      <SessionList
        sessions={[s({ id: 'a', title: 'Mileage', branch: 'feat/mileage', prNumber: 115760 }), s({ id: 'b', title: 'Stale one', isStale: true })]}
        selectedId={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole('heading', { name: 'repo' })).toBeInTheDocument();
    expect(screen.getByText('feat/mileage')).toBeInTheDocument();
    expect(screen.getByText('#115760')).toBeInTheDocument();
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
