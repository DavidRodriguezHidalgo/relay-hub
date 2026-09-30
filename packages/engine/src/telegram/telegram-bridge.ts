import { EventEmitter } from 'node:events';
import { ORCHESTRATOR_KEY, type ApprovalDecision, type MessageOrigin, type RunState, type RunnerEvent, type TelegramBridgeStatus } from '@relay/shared';
import { phoneApprovalVerdict } from './approval-policy';
import { approvalMessage, notificationFor, statusMessage, type SessionNames } from './notifications';
import { TelegramApiError, type InlineKeyboard, type TelegramApi, type TelegramCallbackQuery, type TelegramMessage, type TelegramUpdate, type TelegramUser } from './telegram-api';

/** What the bridge needs from the engine; narrow so a test can stand in for it. */
export interface RelayFacade {
  orchestratorSend(prompt: string, origin: MessageOrigin): Promise<string>;
  runState(): RunState;
  listSessions(): { id: string; title: string; branch: string | null }[];
  decide(approvalId: string, decision: ApprovalDecision): void;
  onEvent(listener: (event: RunnerEvent) => void): () => void;
}

export interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string | null): void;
}

export interface TelegramBridgeOptions {
  api: TelegramApi;
  relay: RelayFacade;
  store: MetaStore;
  /** The one chat honoured; null while unpaired, when the bridge only records who wrote. */
  chatId: number | null;
  now?: () => Date;
  /** Waits, or rejects as soon as the signal aborts; a test makes it instant. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollTimeoutSec?: number;
}

/** Where the last handled update is remembered, so a restart continues rather than repeats. */
const OFFSET_KEY = 'telegram.offset';
/** Which bot that offset belongs to: offsets from one bot mean nothing to another. */
const BOT_KEY = 'telegram.botId';
const POLL_TIMEOUT_SEC = 30;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** Notifications waiting for Telegram to come back; older ones are let go rather than kept for ever. */
const OUTBOUND_MAX = 100;
/** Telegram takes 4096 characters per message; a little under, to be safe. */
const CHUNK = 4000;

const HELP = [
  'Relay is listening.',
  '',
  'Send an instruction and Relay finds the session, e.g. "tell the mileage session to add tests for the zero-rate case".',
  '/status — what is running, answered without the AI.',
  '',
  'Approvals arrive here with buttons. Most destructive commands can only be allowed at the machine; Deny always works.',
].join('\n');

type Outbound =
  | { kind: 'send'; text: string; keyboard?: InlineKeyboard; onSent?: (messageId: number) => void }
  | { kind: 'edit'; messageId: number; text: string };

type BridgeEvents = { status: [TelegramBridgeStatus] };

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

const nameOf = (u: TelegramUser): string =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : String(u.id));

const chunk = (text: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK) out.push(text.slice(i, i + CHUNK));
  return out.length > 0 ? out : [''];
};

/** `a:<approvalId>:allow|deny`, well under Telegram's 64 bytes of callback data. */
const callbackData = (approvalId: string, action: 'allow' | 'deny') => `a:${approvalId}:${action}`;
const parseCallback = (data: string | undefined): { approvalId: string; action: 'allow' | 'deny' } | null => {
  const m = data?.match(/^a:(.+):(allow|deny)$/);
  return m ? { approvalId: m[1]!, action: m[2] as 'allow' | 'deny' } : null;
};

/**
 * One Telegram chat as a way into Relay: polls the bot for messages, hands them to the
 * orchestrator, and sends back its replies plus the few notifications worth a phone buzz.
 *
 * It never listens on a port. Everything inbound is a poll the Mac makes; everything outbound
 * goes through one queue that survives Telegram being unreachable for a while.
 */
export class TelegramBridge extends EventEmitter<BridgeEvents> {
  private readonly api: TelegramApi;
  private readonly relay: RelayFacade;
  private readonly store: MetaStore;
  private readonly chatId: number | null;
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly pollTimeoutSec: number;
  private readonly abort = new AbortController();
  private st: TelegramBridgeStatus;
  private polling: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly outbound: Outbound[] = [];
  /** Set and cleared synchronously around the drain loop, so an enqueue can never fall between the two. */
  private drainActive = false;
  private draining: Promise<void> | null = null;
  /** What the orchestrator has said so far in a turn the phone started. */
  private reply: string[] = [];
  /** Telegram message per pending approval, so a decision can be shown on it. */
  private readonly approvalMessages = new Map<string, { messageId: number; text: string }>();

  constructor(opts: TelegramBridgeOptions) {
    super();
    this.api = opts.api;
    this.relay = opts.relay;
    this.store = opts.store;
    this.chatId = opts.chatId;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? POLL_TIMEOUT_SEC;
    this.st = { botUsername: null, chatId: opts.chatId, candidate: null, connection: 'stopped', lastError: null, lastPolledAt: null, ignored: 0 };
  }

  status(): TelegramBridgeStatus {
    return { ...this.st, candidate: this.st.candidate ? { ...this.st.candidate } : null };
  }

  start(): void {
    if (this.polling) return;
    this.patch({ connection: 'starting' });
    this.unsubscribe = this.relay.onEvent((e) => this.onEvent(e));
    this.polling = this.poll(this.abort.signal).catch((err: unknown) => {
      // the loop catches its own errors; anything here is a bug, and must not take the app down
      this.patch({ connection: 'stopped', lastError: err instanceof Error ? err.message : String(err) });
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.abort.abort();
    await this.polling;
    await this.draining;
    this.patch({ connection: 'stopped' });
  }

  /** One message to the paired chat, straight away; throws so Settings can show why it failed. */
  async sendTest(): Promise<void> {
    if (this.chatId === null) throw new Error('No chat is paired yet.');
    await this.api.sendMessage(this.chatId, 'Relay Hub can reach this phone.');
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let backoff = BACKOFF_MIN_MS;
    const stored = this.store.getMeta(OFFSET_KEY);
    let offset: number | null = stored === null ? null : Number(stored);
    while (!signal.aborted) {
      try {
        if (!this.st.botUsername) {
          const me = await this.api.getMe(signal);
          this.patch({ botUsername: me.username ?? String(me.id) });
          // A different bot numbers its updates from scratch, so an offset kept from the last one
          // would confirm-and-discard everything the new bot has to say, for ever.
          if (this.store.getMeta(BOT_KEY) !== String(me.id)) {
            this.store.setMeta(BOT_KEY, String(me.id));
            this.store.setMeta(OFFSET_KEY, null);
            offset = null;
          }
        }
        const updates = await this.api.getUpdates(offset, this.pollTimeoutSec, signal);
        backoff = BACKOFF_MIN_MS;
        this.patch({ connection: 'ok', lastError: null, lastPolledAt: this.now().toISOString() });
        for (const u of updates) {
          if (signal.aborted) return;
          try {
            await this.handle(u);
          } catch (err) {
            // handling failed on its own terms, which the poll loop must not read as Telegram
            // being unreachable: retrying the same update for ever would wedge the bridge
            this.send(`Relay could not handle that: ${err instanceof Error ? err.message : String(err)}`);
          }
          // only once the update is Relay's problem: a crash before this line means Telegram sends it again
          offset = u.update_id + 1;
          this.store.setMeta(OFFSET_KEY, String(offset));
        }
      } catch (err) {
        if (signal.aborted) return;
        const status = err instanceof TelegramApiError ? err.status : null;
        if (status === 401) {
          this.patch({ connection: 'stopped', lastError: 'Telegram rejected the bot token. Check it in Settings.' });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.patch({
          connection: 'unreachable',
          lastError:
            status === 409
              ? `${message} — a webhook or another program is reading this bot's updates. If that is not you, revoke the token at BotFather.`
              : message,
        });
        await this.sleep(backoff, signal).catch(() => undefined);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) return this.handlePress(update.callback_query);
    const m = update.message;
    if (!m) return;
    if (m.chat.type !== 'private' || !m.from || m.from.id !== m.chat.id) return this.ignore();
    if (this.chatId === null) {
      this.patch({ candidate: { chatId: m.chat.id, name: nameOf(m.from), at: this.now().toISOString() } });
      return;
    }
    if (m.chat.id !== this.chatId) return this.ignore();
    await this.handleMessage(m);
  }

  private async handleMessage(m: TelegramMessage): Promise<void> {
    if (typeof m.text !== 'string') return this.send('Only text reaches Relay.');
    const text = m.text.trim();
    // "/status@relay_bot" is how a client addresses one bot among several
    const command = (text.split(/\s+/)[0] ?? '').toLowerCase().replace(/@\w+$/, '');
    if (command === '/start' || command === '/help') return this.send(HELP);
    if (command === '/status') return this.send(this.statusText());
    void this.api.sendChatAction(this.chatId!, 'typing').catch(() => undefined);
    try {
      await this.relay.orchestratorSend(text, 'telegram');
    } catch (err) {
      this.send(`Relay could not take that: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handlePress(q: TelegramCallbackQuery): Promise<void> {
    const chat = q.message?.chat;
    if (this.chatId === null || q.from.id !== this.chatId || !chat || chat.id !== this.chatId) return this.ignore();
    const answer = (text: string) => this.api.answerCallbackQuery(q.id, text).catch(() => undefined);
    const parsed = parseCallback(q.data);
    const approval = parsed ? this.relay.runState().approvals.find((a) => a.id === parsed.approvalId) : undefined;
    if (!parsed || !approval) return answer('Already decided.');
    if (parsed.action === 'allow') {
      const verdict = phoneApprovalVerdict(approval);
      if (!verdict.allowOnce) return answer(`Not from a phone: ${verdict.why}.`);
      this.relay.decide(approval.id, { kind: 'allow-once' });
      return answer('Allowed once');
    }
    this.relay.decide(approval.id, { kind: 'deny', message: 'denied from the phone' });
    return answer('Denied');
  }

  private onEvent(e: RunnerEvent): void {
    if (this.chatId === null) return;
    switch (e.type) {
      case 'approval': {
        const verdict = phoneApprovalVerdict(e.approval);
        const text = approvalMessage(e.approval, verdict, this.names);
        const row = [{ text: 'Deny', callback_data: callbackData(e.approval.id, 'deny') }];
        if (verdict.allowOnce) row.push({ text: 'Allow once', callback_data: callbackData(e.approval.id, 'allow') });
        const id = e.approval.id;
        this.enqueue({ kind: 'send', text, keyboard: { inline_keyboard: [row] }, onSent: (messageId) => this.approvalMessages.set(id, { messageId, text }) });
        return;
      }
      case 'approval-resolved': {
        const shown = this.approvalMessages.get(e.approvalId);
        if (!shown) return;
        this.approvalMessages.delete(e.approvalId);
        const outcome = e.decision === 'deny' ? 'Denied.' : e.decision === 'allow-pattern' ? 'Allowed, and this kind from now on.' : 'Allowed once.';
        this.enqueue({ kind: 'edit', messageId: shown.messageId, text: `${shown.text}\n\n→ ${outcome}` });
        return;
      }
      case 'entry':
        if (e.sessionId === ORCHESTRATOR_KEY && e.entry.role === 'assistant' && e.entry.origin === 'telegram' && !e.entry.isSidechain) {
          const text = e.entry.blocks.flatMap((b) => (b.kind === 'text' && b.text.trim() ? [b.text.trim()] : [])).join('\n');
          if (text) this.reply.push(text);
        }
        return;
      case 'turn-end':
        if (e.sessionId === ORCHESTRATOR_KEY) {
          const said = this.reply;
          this.reply = [];
          if (e.origins.includes('telegram')) this.send(this.replyText(said, e));
          return;
        }
        break;
      default:
        break;
    }
    const text = notificationFor(e, this.names);
    if (text) this.send(text);
  }

  private replyText(said: string[], end: Extract<RunnerEvent, { type: 'turn-end' }>): string {
    const body = said.length > 0 ? said.join('\n\n') : (end.lastText ?? '');
    if (end.error) return `✖ Relay hit an error: ${end.error}`;
    if (end.aborted) return body ? `■ Relay was stopped.\n\n${body}` : '■ Relay was stopped.';
    return body || '(Relay had nothing to say.)';
  }

  private readonly names: SessionNames = {
    session: (id) => this.relay.listSessions().find((s) => s.id === id) ?? null,
  };

  private statusText(): string {
    const run = this.relay.runState();
    const running = run.bulkRuns.find((r) => r.status === 'running');
    return statusMessage({
      sessions: this.relay.listSessions(),
      states: run.states,
      approvals: run.approvals.length,
      orchestrator: run.states[ORCHESTRATOR_KEY]?.state ?? 'idle',
      bulkRunning: running
        ? { done: running.rows.filter((r) => r.status === 'done' || r.status === 'error').length, total: running.rows.filter((r) => r.status !== 'skipped').length }
        : null,
    });
  }

  private ignore(): void {
    this.patch({ ignored: this.st.ignored + 1 });
  }

  /** Nothing is ever sent while unpaired: there is no one to send it to. */
  private send(text: string): void {
    if (this.chatId === null) return;
    for (const part of chunk(text)) this.enqueue({ kind: 'send', text: part });
  }

  private enqueue(item: Outbound): void {
    if (this.abort.signal.aborted) return;
    if (this.outbound.length >= OUTBOUND_MAX) {
      // index 0 may be in flight; dropping it would lose a message that is on its way out and
      // then let the delivery's own shift() discard an innocent one behind it
      this.outbound.splice(this.drainActive ? 1 : 0, 1);
    }
    this.outbound.push(item);
    if (this.drainActive) return;
    this.drainActive = true;
    this.draining = this.drain();
  }

  /** Delivers in order; a network failure waits and retries the same item, a refusal drops it. */
  private async drain(): Promise<void> {
    const signal = this.abort.signal;
    let backoff = BACKOFF_MIN_MS;
    try {
      while (this.outbound.length > 0 && !signal.aborted) {
        const item = this.outbound[0]!;
        try {
          await this.deliver(item);
          this.outbound.shift();
          backoff = BACKOFF_MIN_MS;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const refused = err instanceof TelegramApiError && err.status >= 400 && err.status < 500 && err.status !== 429;
          this.patch({ lastError: `Could not send to Telegram: ${message}` });
          if (refused) {
            this.outbound.shift();
            continue;
          }
          await this.sleep(backoff, signal).catch(() => undefined);
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        }
      }
    } finally {
      // Cleared in the same synchronous step as the loop's last check: awaiting a nested
      // function here would let an enqueue land in between and sit in the queue for ever.
      this.drainActive = false;
    }
  }

  private async deliver(item: Outbound): Promise<void> {
    // the signal goes with it: quitting must not wait out a request to a Telegram that has stopped answering
    const signal = this.abort.signal;
    if (item.kind === 'edit') return this.api.editMessageText(this.chatId!, item.messageId, item.text, undefined, signal);
    const { messageId } = await this.api.sendMessage(this.chatId!, item.text, item.keyboard, signal);
    item.onSent?.(messageId);
  }

  private patch(changes: Partial<TelegramBridgeStatus>): void {
    const next = { ...this.st, ...changes };
    const same = JSON.stringify(next) === JSON.stringify(this.st);
    this.st = next;
    if (!same) this.emit('status', this.status());
  }
}
