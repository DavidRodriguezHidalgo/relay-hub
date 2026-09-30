# Telegram bridge — design

Relay Hub runs on a Mac and drives local Claude Code sessions. This adds a way to reach it
from a phone through a Telegram bot. The Mac polls Telegram's API; nothing listens on a
port, nothing is exposed to the internet, and it works from any network.

## What the phone can do

- **Send an instruction.** Any text you send the bot goes to the Relay orchestrator — the
  same agent as the app's chat, with the same tools — with origin `telegram`. It finds the
  session, sends to it, and its reply comes back to the phone. If it needs you to choose
  between sessions, it asks, and you answer in the same chat.
- **Ask what is running.** `/status` is answered by Relay itself, without AI: sessions that
  are running, waiting on an approval, or errored, plus the count of pending approvals.
  Free text such as "what's running?" also works, through the orchestrator.
- **Be told when it matters.** See *Notifications*.
- **Decide an approval, within limits.** See *Approvals*.

## Architecture

```
phone ── Telegram servers ◄── long poll (getUpdates) ── TelegramBridge (engine) ── RelayEngine
                          ◄── sendMessage / editMessageText ──┘         │
                                                                         └── Orchestrator, ApprovalQueue, events
```

Everything lives in `packages/engine/src/telegram/`:

| Unit | Does | Depends on |
|---|---|---|
| `telegram-api.ts` | The five Bot API calls used (`getMe`, `getUpdates`, `sendMessage`, `editMessageText`, `answerCallbackQuery`) over `fetch`. Base URL and `fetch` injectable. | nothing |
| `approval-policy.ts` | Pure: which pending approvals may be *allowed* from a phone. | `rules.ts` |
| `notifications.ts` | Pure: which `RunnerEvent`s become a phone message, and the text. | shared types |
| `telegram-bridge.ts` | Poll loop, authentication, routing, approvals, outbound queue, status. | the three above, a `RelayFacade` |

`RelayEngine` owns the bridge (`startTelegram`, `stopTelegram`, `telegramStatus`), passes it
a narrow facade of itself and its store, and publishes `{ type: 'telegram' }` events when the
bridge's status changes. The desktop app owns the *secret*: it stores the token, decides
whether to start the bridge, and shows Settings.

Two additions to shared types: `MessageOrigin` gains `'telegram'`; `RunnerEvent` gains
`{ type: 'turn-end' }` (a session's turn ended: origins, last text, error, aborted) and
`{ type: 'telegram'; status }`. The orchestrator's turn-end is published under
`ORCHESTRATOR_KEY` like its other events.

## Authentication

The bridge is bound to exactly one Telegram **chat id**, yours. Binding happens at the Mac:

1. You paste the bot token in Settings. The bridge starts polling but is **unpaired**: it
   acts on nothing and replies to nobody.
2. You message the bot from your phone. The bridge records the sender (chat id, name) as a
   *candidate* and Settings shows "Message from *Name* (chat 1234). Pair this chat?".
3. You click **Pair** in Settings. From then on only that chat id is honoured.

Every update is checked: the chat must be a private chat, `chat.id` and `from.id` must both
equal the bound id (so a group the bot was added to never counts), and callback buttons are
checked the same way. Anything else is dropped without a reply — the bot does not confirm it
exists — and counted in Settings as "N messages from other chats ignored".

**If someone gets the bot token** they can, until you revoke it: read what you send the bot
from then on (they can call `getUpdates` too, and every update they consume is one Relay
never sees — so instructions and approval prompts, which name sessions and commands, leak to
them and go missing for you); send messages *to you* as the bot, i.e. impersonate Relay,
including fake "finished" or "approval needed" texts; and stop Relay receiving anything by
registering a webhook, which makes `getUpdates` fail. **They cannot drive your Mac.**
Authority comes from your chat id on incoming updates, which Telegram sets from the real
sender; the Bot API gives no way to forge an incoming message from your account. Relay
surfaces the webhook case ("Telegram reports a webhook on this bot — revoke the token") and
a rejected token. Recovery is `/revoke` at BotFather and pasting the new token.

The token is stored in `telegram.json` in the app's data directory, encrypted with
Electron's `safeStorage` (Keychain-backed on macOS); it never touches the repository. If
encryption is unavailable it is stored in the clear and Settings says so.

## Approvals from a phone

A session mid-turn may stop on a destructive command or a path outside its folder. From a
phone you see one line — the command — and not the transcript, the diff, or the branch. So:

- **Deny** is always offered. Refusing is safe: the session is told and carries on.
- **Allow once** is offered only when every destructive step in the command is one whose
  damage is local and recoverable from the reflog: `git rebase` (not `--continue`/`--abort`,
  which never ask), `git commit --amend`, and `git push --force-with-lease` (the lease
  refuses to overwrite work you have not seen). Nothing else: not `rm -rf`, not plain
  `--force`/`-f`, not branch deletion, `reset --hard`, `clean`, `branch -D`, `filter-*`,
  and never a path outside the session's folder or a blocked path — those need the context
  you do not have on a phone.
- **Allow this kind** (a standing permission) is never offered from the phone.

An approval message carries the buttons; pressing one answers the same `ApprovalQueue` the
app uses. If the approval was meanwhile decided in the app, the button says so and the
Telegram message is edited to show the decision, so the phone never shows a stale prompt.

## Notifications

One message each, no more:

| Event | Sent? | Why |
|---|---|---|
| Approval needed | yes, with buttons | The one thing that blocks work until you act. |
| A session's turn ended, started by you from the phone or by the orchestrator | yes: title, last reply (clipped to 300 chars) | That is work you delegated; you want to hear it ended. |
| A session's turn ended, started from the session's own box in the app | no | You were at the keyboard; each message would buzz the phone mid-conversation. |
| A session's turn ended, started by a PR watch or a bulk row | no | Watches fire on their own schedule; bulk rows are summarised once. |
| Session error | yes | Something you asked for died. |
| Bulk run finished | yes, one summary | One message for N sessions, never N. |
| Bulk run proposed | yes, a notice | It waits for the plan card in the app; you should know it is stuck on you. |
| PR events, state changes, queue changes, todos, external sessions, watch changes | no | Noise; the app shows them. |
| Orchestrator reply to a phone message | yes (that is the reply, not a notification) | |

Replies and notifications are plain text (no Telegram markup, so a stray `_` in a command can
never make a message fail to send), split at 4000 characters.

## Never losing a message

- Long polling with an `offset` persisted in the engine's store (`telegram.offset`). The
  offset advances only after the update has been handed to the orchestrator's queue (the
  same durability the app's chat has). A crash in between means Telegram redelivers on
  restart; Telegram keeps undelivered updates for 24 hours.
- Telegram unreachable: the poll loop backs off (1s doubling to 60s), status shows
  "unreachable since …", nothing throws out of the loop. Outbound messages wait in a bounded
  queue (100) and are retried with the same backoff. On quit the outbound queue is dropped —
  notifications, not your instructions.
- HTTP 401 stops polling with "token rejected" (no point hammering). 409 reports the webhook
  case above and keeps retrying slowly.
- Restart: the desktop reads `telegram.json`, starts the bridge with the token and chat id,
  the bridge reads its offset. Pending approvals do not survive a restart anyway (their
  runners are gone), so their Telegram messages are simply left as they are.

## Quiet when unconfigured

No `telegram.json` → the bridge is never constructed, no IPC call fails, Settings shows the
setup instructions and one token field. No polling, no logging, no status. The e2e suite runs
with a fresh data directory and so exercises exactly this path.

## Deliberately not exposed

- **Taking over a terminal session.** Not a tool the orchestrator has, and the bridge adds
  nothing to its toolset.
- **Allow this kind / Allow all actions.** Standing permissions are set at the machine.
- **Confirming a bulk run.** The plan card exists so you tick rows with context; the phone
  gets a notice that one is waiting.
- **Transcripts, files, diffs, screenshots.** The phone gets the orchestrator's answers and
  clipped last replies, not file contents.
- **Model switching, settings, todos, watches from the phone.** Not wired; the orchestrator
  can still create a watch if asked, as it can from the app.
- **Groups, channels, more than one user.** Private chat with one bound id only.
- **Message history.** The bot only sees what is sent after it exists; nothing is fetched.
- **Media.** Photos and voice notes get "Only text reaches Relay."

## Settings

One section, *Telegram*, in the existing dialog, using the existing row/note/error classes
and theme tokens (no new colours):

- **No token:** numbered setup steps and a token field with *Save*.
- **Token, unpaired:** the bot's `@username` (from `getMe`), "Send your bot a message from
  your phone", the candidate when one arrives with **Pair this chat**, and *Remove token*.
- **Paired:** "Paired with *Name* (chat id)", connection state and last error, **Send test
  message**, *Unpair*, *Remove token*.

The token is write-only in the UI: never shown back.

## Testing

- `telegram-api`: request shapes and error mapping against a fake `fetch`.
- `approval-policy`: table of commands → allowed-from-phone or not.
- `notifications`: table of events → message or null.
- `telegram-bridge`: with a fake API and a fake facade — pairing, rejection of other chats,
  routing to the orchestrator with origin `telegram`, reply capture, offset persisted only
  after hand-off, approval buttons and the already-decided case, backoff on failure, 401/409,
  outbound retry, clean stop.
- `RelayEngine`: turn-end events are published; the bridge starts/stops through the engine.
- Desktop: `telegram-config` round-trips through a fake `safeStorage`; Settings shows each
  state and calls the right handler; `useRunState` ignores the new events.
- Live, opt-in: `RELAY_LIVE_TELEGRAM=<token>:<chatId>` sends a real message and reads it
  back with `getMe`; a fake-server run drives the real engine end to end.
