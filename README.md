# Relay Hub

One window for every Claude Code session on your Mac.

If you work with Claude Code, your sessions pile up across terminal tabs and windows. One is
running tests, another is waiting for you to approve something, a third finished twenty minutes
ago and you never noticed. Relay Hub puts them all in one place, so you can see what is happening
and get on with the next thing.

## What you can do with it

**See everything at a glance.** Every session you have on this machine, grouped by project, with
what it is doing right now: working, waiting on you, finished, or open somewhere else. Search by
name, and hide the projects you are not thinking about today.

**Read any session's history.** Open a session and read the whole conversation — what you asked,
what it did, what it changed. Leave and come back and you are still where you were reading.

**Tell Relay what you want, in one chat.** Instead of finding the right tab, ask: "tell the
mileage session to add tests for the zero-rate case". Relay finds it, sends it, and reports back
when that session is done. Ask what is running, and it tells you.

**Change many sessions at once.** "Rebase every open PR branch onto main." Relay shows you a plan
first — one line per session, with what it will say to each — and nothing happens until you tick
the ones you want and press go. You get one summary at the end instead of chasing each one.

**Approve the risky things.** Ordinary edits just happen. Anything destructive, like a force push
or a reset, or anything reaching outside the session's own folder, stops and waits for you, with a
notification so you do not have to watch. Say "allow this kind" once and it stops asking for that
again.

**Take over a session you left in a terminal.** If a session is open somewhere else, Relay will
not touch it — two things typing into one conversation ends badly. Press **Take over** and, after
you confirm, it closes the other one and picks the conversation up from where it was.

**Start new work.** Ask Relay to start a session for a new piece of work and it sets up its own
branch and folder, so it never disturbs what you already have checked out.

**Keep an eye on pull requests.** Point Relay at a session's PR and it watches it for you. When CI
fails, when someone reviews or comments, or when the branch falls behind, it wakes that session
with the news. A merged PR stops being watched. Watching costs nothing — no AI usage, just Relay
checking.

**Message Relay from your phone.** Set up a Telegram bot and you can send instructions, ask what
is running, and be told when something finishes or needs you — from anywhere. Your Mac polls
Telegram, so nothing of yours is exposed to the internet and no ports are opened. See
[Messaging Relay from your phone](#messaging-relay-from-your-phone).

## Demo


https://github.com/user-attachments/assets/3553daa8-7bb2-42aa-911a-f1df210b061e



## What you need

- A Mac.
- [Claude Code](https://claude.com/claude-code) installed and signed in. Relay drives your real
  sessions, so whatever Claude Code can do on this machine, Relay can do through it.
- [Node.js](https://nodejs.org) 22.13 or newer, and [pnpm](https://pnpm.io).
- The [GitHub CLI](https://cli.github.com) (`gh`), signed in with `gh auth login`, if you want the
  pull request watching. Everything else works without it.

## Install and run

From the repository root:

```sh
pnpm install
pnpm dev
```

`pnpm dev` opens the app.

If it stops with "Electron failed to install correctly", the app's runtime was not downloaded
during install. Run this once from the repository root, then `pnpm dev` again:

```sh
node node_modules/electron/install.js
```

### As a built app

From the repository root:

```sh
pnpm --filter @relay/desktop package
open apps/desktop/out/*/Relay\ Hub.app
```

To get a zip you can keep or move elsewhere:

```sh
pnpm --filter @relay/desktop make
```

The zip lands in `apps/desktop/out/make/`.

## Worth knowing

The built app is not signed, so the first time you open it macOS will warn you it is from an
unidentified developer. Right-click the app and choose Open to get past it.

Relay checks for a newer release when it starts and offers it in Settings, with the version you
are on and what is new. **Download the new version** fetches the build to your Downloads folder
and shows it in Finder; you quit Relay, drag the new app over the old one and open it again. It
cannot install over itself, because an unsigned app is not allowed to.

Run from this checkout instead and Settings offers the other path: it lists the commits waiting
on your branch and **Pull and update this working copy** fast-forwards, reinstalling dependencies
if they changed. It refuses, with the reason, if anything is uncommitted, the branch tracks
nothing, the head is detached, or the pull would need a merge — it never stashes, resets or
discards anything.

One thing is missing from the built app today: the box for typing directly to a single session,
and its `/` menu of your commands and skills, only appear when you run with `pnpm dev`. In the
built app you drive sessions through the Relay chat instead. Everything else works in both.

## Messaging Relay from your phone

Relay can be driven from Telegram. Your Mac polls Telegram's API every few seconds; Telegram
never connects to you, so there is nothing to expose and it works from any network. Until you
set this up, none of it runs: no polling, no errors, nothing in Settings but the steps below.

### Setting it up

1. In Telegram, open a chat with **@BotFather**.
2. Send `/newbot`. It asks for a display name, then a username ending in `bot`.
3. BotFather replies with a token like `123456789:AAH…`. That token *is* the bot — treat it as a
   password.
4. In Relay, open **Settings → Telegram**, paste the token and press **Save token**. Relay stores
   it in your Mac's keychain, in its own file in the app's data folder. It is never written to the
   repository, and the field never shows it back to you.
5. Open your new bot in Telegram **from the phone you want to use** and send it anything. That
   chat becomes yours, Relay replies to say so, and there is nothing else to set up.

Do step 5 straight after step 4. The first chat to message the bot is the one Relay obeys, so the
sooner you claim it the smaller the window in which anyone else could. Settings and a desktop
notification both name the chat that got bound, so if it was not you, unpair and revoke the token.

From then on: send an instruction the way you would type it into the Relay chat ("tell the mileage
session to add tests for the zero-rate case"), or `/status` to hear what is running. `/status` is
answered by Relay itself and costs nothing.

### Who can drive it

Only the chat that claimed the bot. Every message after that is checked against its chat id — a
message from anyone else, or from a group your bot was added to, is dropped without a reply, and
Settings counts how many.

If somebody steals the bot token they can read what you send the bot from then on, and send you
messages that look like Relay. Once a chat is bound they **cannot drive your machine**: authority
comes from the chat id on incoming messages, which Telegram sets from the real sender. They can
also stop messages reaching you, which Relay reports rather than hides.

The one window that matters is between saving the token and sending your first message: whoever
writes first is obeyed. That is the price of having no second setup step — so claim the chat
immediately, and if the notification names someone else, unpair in Settings and revoke the token.
Recovery is `/revoke` at BotFather, then pasting the new token in Settings.

### What a phone may approve

Approvals arrive on the phone with buttons. **Deny** always works. **Allow once** is offered only
for a `git rebase`, a `git commit --amend`, or a `git push --force-with-lease` — steps whose damage
is local and recoverable. Anything that deletes files, force-pushes without a lease, resets hard,
or reaches outside the session's own folder says which it is and waits until you are at the
machine. "Allow this kind" is never offered from a phone.

### What it will not do from a phone

Take over a session open in a terminal; confirm a bulk run (the plan card wants your eyes on the
rows); turn on "allow all actions"; show you files, diffs or transcripts. Those stay at the Mac.

### What it tells you, and what it does not

You hear about: an approval waiting, a session finishing work you asked for from the phone or
through the Relay chat, a session erroring, and one summary per finished bulk run. You do not hear
about: turns you started by typing into a session in the app, PR-watch wake-ups, or any of the
ordinary state changes the window already shows.

## Stopping a session

While a session is working the panel shows **Stop** beside what it is doing; ⌘. does the same
from anywhere in the panel. The turn ends, the transcript records that you stopped it, and the
session is ready for the next instruction at once.

What stopping cannot undo: a tool call already in flight finishes on its own terms. A file the
agent had begun writing stays as it was written, a shell command already started keeps running
to its end, and a commit already made stays made. Stopping ends the turn, not the work the turn
had already set in motion — so check `git status` after stopping something that was editing.

## Working on Relay

Changes reach `main` through a pull request, never a direct push. Branch for what you are
doing, keep the change to one coherent thing, and let CI finish before merging — a red run gets
fixed, not merged and tidied afterwards.

CI runs on every push and pull request: typecheck and the unit tests in one job, the end-to-end
tests that package the app and drive a real Electron in another. Both must pass before `main`
will take the change.

## Licence

[MIT](LICENSE). Use it, change it, ship it; keep the copyright notice.
