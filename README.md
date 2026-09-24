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

One thing is missing from the built app today: the box for typing directly to a single session,
and its `/` menu of your commands and skills, only appear when you run with `pnpm dev`. In the
built app you drive sessions through the Relay chat instead. Everything else works in both.

## Licence

Dual-licensed under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at your option.
