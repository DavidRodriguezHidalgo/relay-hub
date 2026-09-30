import { useCallback, useEffect, useState } from 'react';
import { NO_TELEGRAM, type TelegramBridgeStatus, type TelegramStatus } from '@relay/shared';

export interface TelegramView {
  status: TelegramStatus;
  busy: boolean;
  error: string | null;
  /** A test message went, and the window can say so until the next change. */
  testSent: boolean;
  setToken(token: string | null): Promise<void>;
  pair(chatId: number): Promise<void>;
  unpair(): Promise<void>;
  test(): Promise<void>;
}

/**
 * The Telegram settings as the window sees them.
 *
 * The main process owns the token and the bridge, so every change goes there first and the
 * answer becomes the new state — the window never guesses what took. Live status (a candidate
 * arriving, the connection dropping) comes from the bridge's own events, passed in.
 */
export function useTelegram(live: TelegramBridgeStatus | null): TelegramView {
  const [status, setStatus] = useState<TelegramStatus>(NO_TELEGRAM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testSent, setTestSent] = useState(false);

  useEffect(() => {
    void window.relay.telegramStatus().then(setStatus, () => undefined);
  }, []);

  // the bridge reports its own comings and goings; what the app knows (a token exists, how it is
  // stored) does not change underneath us, so it is kept from the last answer
  useEffect(() => {
    if (live) setStatus((s) => (s.configured ? { ...s, ...live } : s));
  }, [live]);

  const change = useCallback(async (fn: () => Promise<TelegramStatus | void>) => {
    setBusy(true);
    setError(null);
    setTestSent(false);
    try {
      const next = await fn();
      if (next) setStatus(next);
      return true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    status,
    busy,
    error,
    testSent,
    setToken: async (token) => {
      await change(() => window.relay.setTelegramToken(token));
    },
    pair: async (chatId) => {
      await change(() => window.relay.pairTelegram(chatId));
    },
    unpair: async () => {
      await change(() => window.relay.unpairTelegram());
    },
    test: async () => {
      const ok = await change(async () => {
        await window.relay.telegramTest();
      });
      if (ok) setTestSent(true);
    },
  };
}
