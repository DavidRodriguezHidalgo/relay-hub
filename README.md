# Relay Hub

One place for all your Claude Code sessions. Milestone 1: index and read. Milestone 2: drive a session with approvals. Milestone 3: orchestrator chat. Milestone 4: bulk actions. Milestone 5: PR watches. Milestone 6: Continental look, creating sessions.

## Run

```
pnpm install
pnpm dev                                  # Electron app
pnpm test                                 # engine + renderer unit tests
pnpm --filter @relay/desktop test:e2e     # packages the app, then the Playwright smoke test
```

If `pnpm dev` fails with "Electron failed to install correctly", the binary
was not downloaded during install; run `node node_modules/electron/install.js`
once.

## Driving a session (M2)

Select a session and use the dev box at the bottom of its panel (dev builds only). Modes:
`steer` (now), `queue` (after the current turn), `interrupt` (abort, then send). Destructive
git commands and paths outside the session directory wait in the approvals drawer; a macOS
notification fires when one is waiting. A session whose transcript was written in the last
15 s by another process (a terminal) is refused, so a session is driven from one place at a time.

## Orchestrator (M3)

Ask in the middle column ("what is running?", "tell the mileage session to add tests").
Relay lists and inspects sessions, sends to one session at a time and can interrupt it.
When a session it drove finishes, it tells you. It has no shell or file tools of its own;
everything it changes goes through a session, where approvals apply.

## Bulk actions (M4)

Ask for many sessions at once ("rebase every mileage branch onto main"). Relay shows a plan
card with one row per session; untick what you do not want and press **Run on N sessions**.
Rows run three at a time with per-row progress, and Relay gives one summary at the end.
Destructive commands still wait in the approvals drawer.

## PR watches (M5)

Press **Watch PR** in a session's panel (or ask Relay). Every 5 minutes Relay asks `gh` about
that PR and wakes the session with a queued message when CI fails, someone else reviews or
comments, or the PR falls behind or into conflict. A merged PR stops being watched. Polling is
plain code and costs no tokens. Needs `gh auth login`; when `gh` is unavailable a banner says
so and watches pause. Quitting while sessions are mid-turn asks first.

Live read-only check: `RELAY_LIVE_GH=owner/repo#123 pnpm --filter @relay/engine test gh-live`.

## Commands and skills

A session runs with your own settings, so it has the same slash commands, skills and plugins as
the terminal. Type `/` in a session's send box for the list (arrow keys, Enter or Tab to pick,
Escape to close); it comes from the agent runtime itself, so built-ins and plugin-qualified names
are exactly what the session will accept. Settings that allow a command cannot pre-approve what
Relay's approval rules hold back.

## Look

Continental yellow on near-black; follows macOS light/dark (in light mode yellow is only a fill
behind black text). Colours live in `apps/desktop/src/ui/theme.css`, and a test checks every
text/background pair reaches WCAG AA (4.5:1) in both modes.

## Creating sessions (M6)

Ask Relay to start one ("start a session in factorial to add mileage exports"). It asks which
project and, normally, a new branch; then it creates a git worktree next to the repo
(`~/code/factorial` → `~/code/factorial-worktrees/<branch>`, off the freshly fetched default
branch) and starts a fresh Claude session there with your instruction. It refuses when the branch
or directory already exists, and never touches the main checkout. Without a branch the session
starts in the directory you name.

## Layout

```
apps/desktop      Electron (Forge + Vite + React)
packages/engine   session indexing; no Electron imports
packages/shared   types and IPC contract
```

Design: `docs/superpowers/specs/2026-09-23-relay-hub-design.md`
