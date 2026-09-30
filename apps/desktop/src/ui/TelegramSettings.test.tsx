import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NO_TELEGRAM, type TelegramStatus } from '@relay/shared';
import { TelegramSettings } from './TelegramSettings';

const base = {
  status: NO_TELEGRAM,
  busy: false,
  error: null,
  testSent: false,
  onSaveToken: vi.fn(),
  onRemoveToken: vi.fn(),
  onPair: vi.fn(),
  onUnpair: vi.fn(),
  onTest: vi.fn(),
};
const status = (over: Partial<TelegramStatus>): TelegramStatus => ({ ...NO_TELEGRAM, ...over });

describe('TelegramSettings when nothing is set up', () => {
  it('says what to do, in order, and offers only the token field', () => {
    render(<TelegramSettings {...base} />);
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(steps[0]).toMatch(/@BotFather/);
    expect(steps[1]).toMatch(/\/newbot/);
    expect(steps.join(' ')).toMatch(/paste the token/i);
    expect(screen.queryByRole('button', { name: /Pair/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send test/ })).not.toBeInTheDocument();
  });

  it('saves a pasted token', async () => {
    const onSaveToken = vi.fn();
    render(<TelegramSettings {...base} onSaveToken={onSaveToken} />);
    await userEvent.type(screen.getByLabelText('Bot token'), '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
    await userEvent.click(screen.getByRole('button', { name: 'Save token' }));
    expect(onSaveToken).toHaveBeenCalledWith('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
  });

  it('will not save an empty field', async () => {
    const onSaveToken = vi.fn();
    render(<TelegramSettings {...base} onSaveToken={onSaveToken} />);
    expect(screen.getByRole('button', { name: 'Save token' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save token' }));
    expect(onSaveToken).not.toHaveBeenCalled();
  });

  it('keeps the token out of sight as it is typed', () => {
    render(<TelegramSettings {...base} />);
    expect(screen.getByLabelText('Bot token')).toHaveAttribute('type', 'password');
  });
});

describe('TelegramSettings with a token but no paired chat', () => {
  const unpaired = status({ configured: true, storage: 'encrypted', botUsername: 'relay_bot', connection: 'ok' });

  it('names the bot and asks for a message from the phone', () => {
    render(<TelegramSettings {...base} status={unpaired} />);
    expect(screen.getAllByText(/@relay_bot/).length).toBeGreaterThan(0);
    expect(screen.getByText(/a message from your phone/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pair/ })).not.toBeInTheDocument();
  });

  it('offers to pair the chat that wrote, naming who it was', async () => {
    const onPair = vi.fn();
    render(<TelegramSettings {...base} status={status({ ...unpaired, candidate: { chatId: 4242, name: 'David R', at: 't' } })} onPair={onPair} />);
    expect(screen.getByText(/David R/)).toBeInTheDocument();
    expect(screen.getByText(/4242/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Pair this chat' }));
    expect(onPair).toHaveBeenCalledWith(4242);
  });

  it('says plainly that nothing is acted on until a chat is paired', () => {
    render(<TelegramSettings {...base} status={unpaired} />);
    expect(screen.getByText(/Nothing is acted on until you pair a chat/i)).toBeInTheDocument();
  });

  it('removes the token', async () => {
    const onRemoveToken = vi.fn();
    render(<TelegramSettings {...base} status={unpaired} onRemoveToken={onRemoveToken} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove token' }));
    expect(onRemoveToken).toHaveBeenCalled();
  });
});

describe('TelegramSettings once paired', () => {
  const paired = status({
    configured: true, storage: 'encrypted', botUsername: 'relay_bot', connection: 'ok',
    chatId: 4242, chatName: 'David R', lastPolledAt: '2026-09-30T10:00:00.000Z',
  });

  it('says who it is paired with and that it is connected', () => {
    render(<TelegramSettings {...base} status={paired} />);
    expect(screen.getByText(/Paired with David R/)).toBeInTheDocument();
    expect(screen.getByText(/4242/)).toBeInTheDocument();
    expect(screen.getByText(/Connected/)).toBeInTheDocument();
  });

  it('sends a test message and confirms it went', async () => {
    const onTest = vi.fn();
    const { rerender } = render(<TelegramSettings {...base} status={paired} onTest={onTest} />);
    await userEvent.click(screen.getByRole('button', { name: 'Send test message' }));
    expect(onTest).toHaveBeenCalled();
    rerender(<TelegramSettings {...base} status={paired} testSent />);
    expect(screen.getByRole('status')).toHaveTextContent(/Sent/);
  });

  it('unpairs', async () => {
    const onUnpair = vi.fn();
    render(<TelegramSettings {...base} status={paired} onUnpair={onUnpair} />);
    await userEvent.click(screen.getByRole('button', { name: 'Unpair' }));
    expect(onUnpair).toHaveBeenCalled();
  });

  it('shows a connection problem without hiding the rest', () => {
    render(<TelegramSettings {...base} status={status({ ...paired, connection: 'unreachable', lastError: 'fetch failed' })} />);
    expect(screen.getByText(/Cannot reach Telegram/)).toBeInTheDocument();
    expect(screen.getByText(/fetch failed/)).toBeInTheDocument();
    expect(screen.getByText(/Paired with David R/)).toBeInTheDocument();
  });

  it('shows a rejected token as something to act on', () => {
    render(<TelegramSettings {...base} status={status({ ...paired, connection: 'stopped', lastError: 'Telegram rejected the bot token. Check it in Settings.' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/rejected the bot token/);
  });

  it('counts messages from other chats, which is what an intruder would look like', () => {
    render(<TelegramSettings {...base} status={status({ ...paired, ignored: 3 })} />);
    expect(screen.getByText(/3 messages from other chats were ignored/)).toBeInTheDocument();
  });

  it('warns when the token could not be encrypted', () => {
    render(<TelegramSettings {...base} status={status({ ...paired, storage: 'plain' })} />);
    expect(screen.getByText(/could not be encrypted/i)).toBeInTheDocument();
  });

  it('says what a phone can and cannot approve', () => {
    render(<TelegramSettings {...base} status={paired} />);
    expect(screen.getByText(/Denying always works/)).toBeInTheDocument();
  });

  it('reports what went wrong with a change, rather than leaving a dead button', () => {
    render(<TelegramSettings {...base} status={paired} error="That chat has not messaged the bot." />);
    expect(screen.getByRole('alert')).toHaveTextContent('has not messaged the bot');
  });

  it('disables its buttons while a change is in flight', () => {
    render(<TelegramSettings {...base} status={paired} busy />);
    expect(screen.getByRole('button', { name: 'Send test message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Unpair' })).toBeDisabled();
  });
});
