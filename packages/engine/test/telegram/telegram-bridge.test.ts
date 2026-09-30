import { afterEach, describe, expect, it } from 'vitest';
import { ORCHESTRATOR_KEY, type ApprovalDecision, type MessageOrigin, type PendingApproval, type RunnerEvent, type RunState, type TelegramBridgeStatus } from '@relay/shared';
import { TelegramApiError, type InlineKeyboard, type TelegramApi, type TelegramUpdate } from '../../src/telegram/telegram-api';
import { TelegramBridge, type RelayFacade } from '../../src/telegram/telegram-bridge';

/** Answers polls from a queue; a poll with nothing queued waits until `push`, or until aborted. */
class FakeApi implements TelegramApi {
  username: string | null = 'relay_bot';
  polls: (number | null)[] = [];
  sent: { chatId: number; text: string; keyboard?: InlineKeyboard }[] = [];
  edits: { chatId: number; messageId: number; text: string; keyboard?: InlineKeyboard }[] = [];
  answers: { id: string; text?: string }[] = [];
  actions: string[] = [];
  /** Thrown by the next poll / send, once each. */
  failPoll: Error[] = [];
  failSend: (Error | null)[] = [];
  private queue: TelegramUpdate[] = [];
  private waiter: { resolve: (u: TelegramUpdate[]) => void; reject: (e: Error) => void } | null = null;
  private nextMessageId = 100;

  async getMe() {
    return { id: 1, username: this.username };
  }
  getUpdates(offset: number | null, _timeout: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    this.polls.push(offset);
    const fail = this.failPoll.shift();
    if (fail) return Promise.reject(fail);
    if (this.queue.length > 0) return Promise.resolve(this.queue.splice(0));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      signal?.addEventListener('abort', () => {
        this.waiter = null;
        reject(new Error('aborted'));
      }, { once: true });
    });
  }
  push(...updates: TelegramUpdate[]) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(updates);
    } else {
      this.queue.push(...updates);
    }
  }
  async sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard) {
    const fail = this.failSend.shift();
    if (fail) throw fail;
    this.sent.push({ chatId, text, ...(keyboard ? { keyboard } : {}) });
    return { messageId: this.nextMessageId++ };
  }
  async editMessageText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard) {
    this.edits.push({ chatId, messageId, text, ...(keyboard ? { keyboard } : {}) });
  }
  async answerCallbackQuery(id: string, text?: string) {
    this.answers.push({ id, ...(text ? { text } : {}) });
  }
  async sendChatAction(_chatId: number, action: 'typing') {
    this.actions.push(action);
  }
}

class FakeRelay implements RelayFacade {
  sends: { prompt: string; origin: MessageOrigin }[] = [];
  decisions: [string, ApprovalDecision][] = [];
  sessions = [
    { id: 's1', title: 'Add tests', branch: 'feat/zero' },
    { id: 's2', title: 'Fix login', branch: null },
  ];
  state: RunState = { states: {}, approvals: [], bulkRuns: [], watches: [], gh: { state: 'ok' }, external: {}, queue: {} };
  /** Set to hold the next orchestratorSend open until released. */
  hold: { promise: Promise<string>; release: () => void } | null = null;
  rejectWith: Error | null = null;
  private listeners = new Set<(e: RunnerEvent) => void>();

  async orchestratorSend(prompt: string, origin: MessageOrigin) {
    if (this.rejectWith) throw this.rejectWith;
    this.sends.push({ prompt, origin });
    if (this.hold) return this.hold.promise;
    return 'send-1';
  }
  runState() {
    return this.state;
  }
  listSessions() {
    return this.sessions;
  }
  decide(id: string, decision: ApprovalDecision) {
    this.decisions.push([id, decision]);
  }
  onEvent(l: (e: RunnerEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: RunnerEvent) {
    for (const l of this.listeners) l(e);
  }
}

class MemoryStore {
  meta = new Map<string, string>();
  writes: [string, string | null][] = [];
  getMeta(key: string) {
    return this.meta.get(key) ?? null;
  }
  setMeta(key: string, value: string | null) {
    this.writes.push([key, value]);
    if (value === null) this.meta.delete(key);
    else this.meta.set(key, value);
  }
}

const until = async (pred: () => boolean, ms = 2_000) => {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > ms) throw new Error('condition never met');
    await new Promise((r) => setTimeout(r, 1));
  }
};

let updateId = 1;
const ME = 9;
const message = (chatId: number, text: string | null, over: Partial<TelegramUpdate['message'] & object> = {}): TelegramUpdate => ({
  update_id: updateId++,
  message: {
    message_id: updateId,
    chat: { id: chatId, type: 'private', first_name: 'David' },
    from: { id: chatId, first_name: 'David', last_name: 'R' },
    date: 0,
    ...(text === null ? {} : { text }),
    ...over,
  },
});
const press = (fromId: number, data: string, chatId = fromId): TelegramUpdate => ({
  update_id: updateId++,
  callback_query: { id: `cb${updateId}`, from: { id: fromId, first_name: 'D' }, data, message: { message_id: 1, chat: { id: chatId, type: 'private' }, date: 0 } },
});
const approval = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: 'ap1', sessionId: 's1', toolName: 'Bash', input: { command: 'git rebase main' }, summary: 'git rebase main',
  reason: 'destructive-git', cwd: '/c', createdAt: 't', ...over,
});

function setup(chatId: number | null = ME, store = new MemoryStore()) {
  const api = new FakeApi();
  const relay = new FakeRelay();
  const sleeps: number[] = [];
  const statuses: TelegramBridgeStatus[] = [];
  const bridge = new TelegramBridge({
    api, relay, store, chatId,
    now: () => new Date('2026-09-30T10:00:00.000Z'),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  bridge.on('status', (s) => statuses.push(s));
  bridge.start();
  return { api, relay, store, bridge, sleeps, statuses };
}

describe('TelegramBridge', () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await stop?.();
    stop = null;
  });

  describe('pairing and authentication', () => {
    it('unpaired: records who wrote as a candidate, replies to nobody, sends nothing to Relay', async () => {
      const { api, relay, bridge } = setup(null);
      stop = () => bridge.stop();
      api.push(message(42, '/start'));
      await until(() => bridge.status().candidate !== null);
      expect(bridge.status().candidate).toEqual({ chatId: 42, name: 'David R', at: '2026-09-30T10:00:00.000Z' });
      expect(api.sent).toEqual([]);
      expect(relay.sends).toEqual([]);
    });

    it('unpaired: notifications go nowhere', async () => {
      const { api, relay, bridge } = setup(null);
      stop = () => bridge.stop();
      relay.emit({ type: 'approval', approval: approval() });
      relay.emit({ type: 'turn-end', sessionId: 's1', origins: ['orchestrator'], lastText: 'x', error: null, aborted: false });
      await new Promise((r) => setTimeout(r, 5));
      expect(api.sent).toEqual([]);
    });

    it('paired: drops messages from any other chat without a reply, and counts them', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      api.push(message(5, 'hello'));
      await until(() => bridge.status().ignored === 1);
      expect(api.sent).toEqual([]);
      expect(relay.sends).toEqual([]);
      expect(bridge.status().candidate).toBeNull();
    });

    it('paired: a group the bot was added to never counts, even when the sender is me', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      api.push({ update_id: updateId++, message: { message_id: 1, chat: { id: -100, type: 'group' }, from: { id: ME, first_name: 'D' }, date: 0, text: 'hi' } });
      await until(() => bridge.status().ignored === 1);
      expect(relay.sends).toEqual([]);
    });

    it('a button pressed by someone else, or on a message in another chat, is ignored', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.state.approvals = [approval()];
      api.push(press(5, 'a:ap1:deny'), press(ME, 'a:ap1:deny', -100));
      await until(() => bridge.status().ignored === 2);
      expect(relay.decisions).toEqual([]);
      expect(api.answers).toEqual([]);
    });
  });

  describe('instructions', () => {
    it('hands text to the orchestrator as coming from the phone, shows typing, and advances the offset only once handed over', async () => {
      const { api, relay, store, bridge } = setup();
      stop = () => bridge.stop();
      let release!: () => void;
      relay.hold = { promise: new Promise<string>((r) => { release = () => r('id'); }), release: () => release() };
      const u = message(ME, 'tell the mileage session to add tests');
      api.push(u);
      await until(() => relay.sends.length === 1);
      expect(relay.sends[0]).toEqual({ prompt: 'tell the mileage session to add tests', origin: 'telegram' });
      expect(api.actions).toEqual(['typing']);
      expect(store.getMeta('telegram.offset')).toBeNull();
      relay.hold.release();
      await until(() => store.getMeta('telegram.offset') !== null);
      expect(store.getMeta('telegram.offset')).toBe(String(u.update_id + 1));
    });

    it('resumes from the stored offset after a restart', async () => {
      const store = new MemoryStore();
      store.meta.set('telegram.offset', '77');
      store.meta.set('telegram.botId', '1'); // the same bot the fake reports
      const { api, bridge } = setup(ME, store);
      stop = () => bridge.stop();
      await until(() => api.polls.length === 1);
      expect(api.polls[0]).toBe(77);
    });

    it('throws away an offset that belonged to a different bot, which would swallow everything the new one says', async () => {
      const store = new MemoryStore();
      store.meta.set('telegram.offset', '9999');
      store.meta.set('telegram.botId', '7'); // a bot that is not the one answering now
      const { api, store: s, bridge } = setup(ME, store);
      stop = () => bridge.stop();
      await until(() => api.polls.length >= 1);
      expect(api.polls[0]).toBeNull();
      expect(s.getMeta('telegram.botId')).toBe('1');
      // and a message from the new bot is acted on rather than confirmed away
      api.push(message(ME, '/help'));
      await until(() => api.sent.length === 1);
    });

    it('says when Relay would not take the message, and still moves on', async () => {
      const { api, relay, store, bridge } = setup();
      stop = () => bridge.stop();
      relay.rejectWith = new Error('busy elsewhere');
      const u = message(ME, 'x');
      api.push(u);
      await until(() => api.sent.length === 1);
      expect(api.sent[0]!.text).toBe('Relay could not take that: busy elsewhere');
      await until(() => store.getMeta('telegram.offset') === String(u.update_id + 1));
    });

    it('answers /status itself, from the run state, without the AI', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.state.states = { s1: { state: 'running', error: null } };
      api.push(message(ME, '/status@relay_bot'));
      await until(() => api.sent.length === 1);
      expect(api.sent[0]!.text).toBe('Running: Add tests (feat/zero)');
      expect(relay.sends).toEqual([]);
    });

    it('explains itself on /start and /help', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      api.push(message(ME, '/start'), message(ME, '/help'));
      await until(() => api.sent.length === 2);
      expect(api.sent[0]!.text).toContain('/status');
      expect(relay.sends).toEqual([]);
    });

    it('passes other slash commands through: they may be a session command', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      api.push(message(ME, '/review 3497 in the mileage session'));
      await until(() => relay.sends.length === 1);
    });

    it('says that only text reaches Relay', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      api.push(message(ME, null));
      await until(() => api.sent.length === 1);
      expect(api.sent[0]!.text).toBe('Only text reaches Relay.');
      expect(relay.sends).toEqual([]);
    });
  });

  describe('replies', () => {
    const entry = (text: string, origin: MessageOrigin = 'telegram'): RunnerEvent => ({
      type: 'entry', sessionId: ORCHESTRATOR_KEY,
      entry: { uuid: text, role: 'assistant', timestamp: 't', isSidechain: false, isMeta: false, blocks: [{ kind: 'text', text }], origin },
    });
    const end = (over: Partial<Extract<RunnerEvent, { type: 'turn-end' }>> = {}): RunnerEvent => ({
      type: 'turn-end', sessionId: ORCHESTRATOR_KEY, origins: ['telegram'], lastText: 'Sent.', error: null, aborted: false, ...over,
    });

    it("sends everything the orchestrator said in a phone-started turn, once the turn ends", async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.emit(entry('Sending to Add tests (feat/zero): add tests.'));
      relay.emit(entry('Sent. I will tell you when it finishes.'));
      expect(api.sent).toEqual([]);
      relay.emit(end());
      await until(() => api.sent.length === 1);
      expect(api.sent[0]!.text).toBe('Sending to Add tests (feat/zero): add tests.\n\nSent. I will tell you when it finishes.');
    });

    it("says nothing about turns the app started, and does not mix their words into the next reply", async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.emit(entry('for the app', 'user'));
      relay.emit(end({ origins: ['user'] }));
      await new Promise((r) => setTimeout(r, 5));
      expect(api.sent).toEqual([]);
      relay.emit(entry('for the phone'));
      relay.emit(end());
      await until(() => api.sent.length === 1);
      expect(api.sent[0]!.text).toBe('for the phone');
    });

    it('falls back to the last reply when a phone message folded into a turn the app started', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.emit(entry('said under the app origin', 'user'));
      relay.emit(end({ origins: ['user', 'telegram'], lastText: 'said under the app origin' }));
      await until(() => api.sent.length === 1);
      expect(api.sent[0]!.text).toBe('said under the app origin');
    });

    it('reports an error or a stop instead of silence', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.emit(end({ error: 'expired login', lastText: null }));
      relay.emit(end({ aborted: true, lastText: null }));
      await until(() => api.sent.length === 2);
      expect(api.sent[0]!.text).toBe('✖ Relay hit an error: expired login');
      expect(api.sent[1]!.text).toBe('■ Relay was stopped.');
    });

    it('says when there was nothing to say', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.emit(end({ lastText: null }));
      await until(() => api.sent.length === 1);
      expect(api.sent[0]!.text).toBe('(Relay had nothing to say.)');
    });

    it('splits a long reply so no chunk exceeds what Telegram takes', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.emit(end({ lastText: 'a'.repeat(9000) }));
      await until(() => api.sent.length === 3);
      expect(api.sent.map((s) => s.text.length)).toEqual([4000, 4000, 1000]);
    });
  });

  describe('approvals', () => {
    it('offers Deny and Allow once for a command the phone may allow, and tracks the message', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.emit({ type: 'approval', approval: approval() });
      await until(() => api.sent.length === 1);
      expect(api.sent[0]!.text).toContain('Add tests (feat/zero) wants to run:');
      expect(api.sent[0]!.keyboard).toEqual({ inline_keyboard: [[{ text: 'Deny', callback_data: 'a:ap1:deny' }, { text: 'Allow once', callback_data: 'a:ap1:allow' }]] });
    });

    it('offers only Deny for a command that needs the machine, and says why', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.emit({ type: 'approval', approval: approval({ input: { command: 'rm -rf dist' }, summary: 'rm -rf dist' }) });
      await until(() => api.sent.length === 1);
      expect(api.sent[0]!.text).toContain('needs the machine');
      expect(api.sent[0]!.keyboard).toEqual({ inline_keyboard: [[{ text: 'Deny', callback_data: 'a:ap1:deny' }]] });
    });

    it('a press decides the approval, is acknowledged, and the message is updated when it resolves', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.state.approvals = [approval()];
      relay.emit({ type: 'approval', approval: approval() });
      await until(() => api.sent.length === 1);
      api.push(press(ME, 'a:ap1:allow'));
      await until(() => relay.decisions.length === 1);
      expect(relay.decisions[0]).toEqual(['ap1', { kind: 'allow-once' }]);
      expect(api.answers[0]!.text).toBe('Allowed once');
      relay.emit({ type: 'approval-resolved', approvalId: 'ap1', decision: 'allow-once' });
      await until(() => api.edits.length === 1);
      expect(api.edits[0]).toMatchObject({ chatId: ME, messageId: 100 });
      expect(api.edits[0]!.text).toMatch(/→ Allowed once\.$/);
      expect(api.edits[0]!.keyboard).toBeUndefined();
    });

    it('deny reaches the queue with a message saying where it came from', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.state.approvals = [approval()];
      api.push(press(ME, 'a:ap1:deny'));
      await until(() => relay.decisions.length === 1);
      expect(relay.decisions[0]).toEqual(['ap1', { kind: 'deny', message: 'denied from the phone' }]);
      expect(api.answers[0]!.text).toBe('Denied');
    });

    it('enforces the policy on the press itself, not just by hiding the button', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.state.approvals = [approval({ input: { command: 'git push -f' }, summary: 'git push -f' })];
      api.push(press(ME, 'a:ap1:allow'));
      await until(() => api.answers.length === 1);
      expect(relay.decisions).toEqual([]);
      expect(api.answers[0]!.text).toMatch(/machine/);
    });

    it('says when the approval was already decided elsewhere', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      api.push(press(ME, 'a:gone:allow'), press(ME, 'nonsense'));
      await until(() => api.answers.length === 2);
      expect(api.answers[0]!.text).toBe('Already decided.');
      expect(relay.decisions).toEqual([]);
    });

    it('shows a decision made in the app on the phone too', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.emit({ type: 'approval', approval: approval() });
      await until(() => api.sent.length === 1);
      relay.emit({ type: 'approval-resolved', approvalId: 'ap1', decision: 'deny' });
      await until(() => api.edits.length === 1);
      expect(api.edits[0]!.text).toMatch(/→ Denied\.$/);
    });
  });

  describe('notifications', () => {
    it('sends what the notification policy says, and nothing for the rest', async () => {
      const { api, relay, bridge } = setup();
      stop = () => bridge.stop();
      relay.emit({ type: 'turn-end', sessionId: 's1', origins: ['orchestrator'], lastText: 'Added 3 tests.', error: null, aborted: false });
      relay.emit({ type: 'turn-end', sessionId: 's1', origins: ['user'], lastText: 'chatter', error: null, aborted: false });
      relay.emit({ type: 'state', sessionId: 's2', state: 'running', error: null });
      // a runner that fails emits both of these for one failure; only one message may result
      relay.emit({ type: 'state', sessionId: 's2', state: 'error', error: 'died' });
      relay.emit({ type: 'turn-end', sessionId: 's2', origins: ['orchestrator'], lastText: null, error: 'died', aborted: false });
      await until(() => api.sent.length === 2);
      await new Promise((r) => setTimeout(r, 20));
      expect(api.sent.map((s) => s.text)).toEqual(['✔ Add tests (feat/zero) finished.\n\nAdded 3 tests.', '✖ Fix login failed: died']);
    });
  });

  describe('when Telegram is unreachable', () => {
    it('backs off, doubling to a cap, says so in its status, and recovers', async () => {
      const { api, bridge, sleeps } = setup();
      stop = () => bridge.stop();
      api.failPoll = [new Error('fetch failed'), new Error('fetch failed'), new Error('fetch failed')];
      await until(() => sleeps.length === 3);
      expect(sleeps).toEqual([1_000, 2_000, 4_000]);
      expect(bridge.status()).toMatchObject({ connection: 'unreachable', lastError: 'fetch failed' });
      api.push(message(ME, '/help'));
      await until(() => bridge.status().connection === 'ok');
      expect(bridge.status().lastError).toBeNull();
      expect(bridge.status().lastPolledAt).toBe('2026-09-30T10:00:00.000Z');
    });

    it('stops for good on a rejected token, and says so', async () => {
      const { api, bridge, sleeps } = setup();
      stop = () => bridge.stop();
      api.failPoll = [new TelegramApiError(401, 'Unauthorized')];
      await until(() => bridge.status().connection === 'stopped');
      expect(bridge.status().lastError).toMatch(/rejected the bot token/);
      await new Promise((r) => setTimeout(r, 5));
      expect(sleeps).toEqual([]);
      expect(api.polls).toHaveLength(1);
    });

    it('names the webhook case, which is what a stolen token looks like', async () => {
      const { api, bridge } = setup();
      stop = () => bridge.stop();
      api.failPoll = [new TelegramApiError(409, 'Conflict: terminated by other getUpdates request')];
      await until(() => bridge.status().connection === 'unreachable');
      expect(bridge.status().lastError).toMatch(/revoke the token/);
    });

    it('keeps an outbound message and retries it, but drops one Telegram refuses outright', async () => {
      const { api, relay, bridge, sleeps } = setup();
      stop = () => bridge.stop();
      // per call: the first send fails on the network, its retry succeeds, the next message is refused
      api.failSend = [new Error('fetch failed'), null, new TelegramApiError(400, 'Bad Request: chat not found')];
      relay.emit({ type: 'turn-end', sessionId: 's1', origins: ['orchestrator'], lastText: 'one', error: null, aborted: false });
      relay.emit({ type: 'turn-end', sessionId: 's1', origins: ['orchestrator'], lastText: 'two', error: null, aborted: false });
      relay.emit({ type: 'turn-end', sessionId: 's1', origins: ['orchestrator'], lastText: 'three', error: null, aborted: false });
      await until(() => api.sent.length === 2);
      expect(sleeps).toEqual([1_000]);
      // the first was retried after the network blip; the second Telegram refused and it was dropped; the third still went
      expect(api.sent.map((s) => s.text.split('\n\n')[1])).toEqual(['one', 'three']);
      expect(bridge.status().lastError).toMatch(/chat not found/);
    });
  });

  it('a message it cannot handle is reported and left behind, never retried for ever', async () => {
    const { api, relay, store, bridge } = setup();
    stop = () => bridge.stop();
    relay.orchestratorSend = () => {
      throw new Error('something unexpected');
    };
    const u = message(ME, 'go');
    api.push(u);
    await until(() => api.sent.length === 1);
    expect(api.sent[0]!.text).toMatch(/something unexpected/);
    // the offset moved past it: the same message must not be handed over again on the next poll
    await until(() => store.getMeta('telegram.offset') === String(u.update_id + 1));
  });

  it('drops the oldest waiting message when the queue is full, never the one being delivered', async () => {
    const { api, relay, bridge } = setup();
    stop = () => bridge.stop();
    let release!: () => void;
    // hold the first delivery open so everything after it queues behind it
    api.failSend = [];
    const held = new Promise<void>((r) => {
      release = r;
    });
    const original = api.sendMessage.bind(api);
    let first = true;
    api.sendMessage = async (chatId: number, text: string, keyboard?: InlineKeyboard) => {
      if (first) {
        first = false;
        await held;
      }
      return original(chatId, text, keyboard);
    };
    for (let i = 0; i < 130; i += 1) {
      relay.emit({ type: 'turn-end', sessionId: 's1', origins: ['orchestrator'], lastText: `m${i}`, error: null, aborted: false });
    }
    release();
    await until(() => api.sent.length >= 100, 5_000);
    // the one in flight when the queue filled is the first out, not a casualty of the overflow
    expect(api.sent[0]!.text).toContain('m0');
    expect(api.sent.map((s) => s.text).join('\n')).not.toContain('m129x');
  });

  it('stops promptly, unsubscribes, and reports stopped', async () => {
    const { api, relay, bridge, statuses } = setup();
    await until(() => api.polls.length === 1);
    await bridge.stop();
    expect(bridge.status().connection).toBe('stopped');
    expect(statuses.at(-1)?.connection).toBe('stopped');
    relay.emit({ type: 'turn-end', sessionId: 's1', origins: ['orchestrator'], lastText: 'late', error: null, aborted: false });
    await new Promise((r) => setTimeout(r, 5));
    expect(api.sent).toEqual([]);
  });

  it('learns the bot name and reports it', async () => {
    const { bridge } = setup();
    stop = () => bridge.stop();
    await until(() => bridge.status().botUsername === 'relay_bot');
  });

  it('sendTest sends one message to the paired chat, and refuses while unpaired', async () => {
    const { api, bridge } = setup();
    stop = () => bridge.stop();
    await bridge.sendTest();
    expect(api.sent[0]).toMatchObject({ chatId: ME });
    const unpaired = setup(null);
    await expect(unpaired.bridge.sendTest()).rejects.toThrow(/paired/);
    await unpaired.bridge.stop();
  });
});
