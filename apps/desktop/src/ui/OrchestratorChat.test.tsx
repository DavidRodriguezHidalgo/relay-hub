import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LiveEntry, TranscriptEntry } from '@relay/shared';
import { OrchestratorChat } from './OrchestratorChat';

const text = (uuid: string, role: 'user' | 'assistant', t: string): TranscriptEntry => ({
  uuid, role, timestamp: '2026-09-23T10:00:00.000Z', isSidechain: false, isMeta: false,
  blocks: [{ kind: 'text', text: t }],
});

describe('OrchestratorChat', () => {
  it('shows history then live entries, deduped, with relay updates as compact lines', () => {
    const live: LiveEntry[] = [
      { ...text('h2', 'assistant', 'dup'), origin: 'user' },
      { ...text('l1', 'user', '[turn-end] session "A" finished. Last reply: ok'), origin: 'watch:turn-end' },
      { ...text('l2', 'assistant', 'Session A is done.'), origin: 'watch:turn-end' },
    ];
    render(
      <OrchestratorChat
        history={[text('h1', 'user', 'hi'), text('h2', 'assistant', 'hello')]}
        liveEntries={live}
        state={undefined}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.queryByText('dup')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Relay update' })).toHaveTextContent('session "A" finished');
    expect(screen.getByText('Session A is done.')).toBeInTheDocument();
  });

  it('shows a relay update from history (no origin) as a compact line too', () => {
    render(
      <OrchestratorChat
        history={[text('h1', 'user', '[turn-end] session "B" finished. Last reply: done')]}
        liveEntries={[]}
        state={undefined}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );
    expect(screen.getByRole('status', { name: 'Relay update' })).toHaveTextContent('session "B" finished');
  });

  it('Enter sends and clears, Shift+Enter makes a newline, Interrupt shows while running', async () => {
    const onSend = vi.fn();
    const onInterrupt = vi.fn();
    const { rerender } = render(
      <OrchestratorChat history={[]} liveEntries={[]} state={{ state: 'idle', error: null }} onSend={onSend} onInterrupt={onInterrupt} />,
    );
    const box = screen.getByPlaceholderText('Ask Relay…');
    await userEvent.type(box, 'line one{Shift>}{Enter}{/Shift}line two{Enter}');
    expect(onSend).toHaveBeenCalledWith('line one\nline two');
    expect(box).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument();
    rerender(
      <OrchestratorChat history={[]} liveEntries={[]} state={{ state: 'running', error: null }} onSend={onSend} onInterrupt={onInterrupt} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(onInterrupt).toHaveBeenCalled();
  });

  it('does not send an empty message', async () => {
    const onSend = vi.fn();
    render(<OrchestratorChat history={[]} liveEntries={[]} state={undefined} onSend={onSend} onInterrupt={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText('Ask Relay…'), '   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders a tool result from a relay-started turn as a tool result, not as an update line", () => {
    const toolResult: LiveEntry = {
      uuid: "t1", role: "user", timestamp: "2026-09-23T10:00:00.000Z", isSidechain: false, isMeta: false,
      blocks: [{ kind: "tool_result", toolUseId: "x", text: "[{\"id\":\"a\"}]", isError: false }],
      origin: "watch:turn-end",
    };
    render(<OrchestratorChat history={[]} liveEntries={[toolResult]} state={undefined} onSend={vi.fn()} onInterrupt={vi.fn()} />);
    expect(screen.queryByRole("status", { name: "Relay update" })).not.toBeInTheDocument();
    expect(screen.getByText("[{\"id\":\"a\"}]")).toBeInTheDocument();
  });
});
