# Relay Hub — design

Date: 2026-09-23
Status: draft for review

## Purpose

Relay Hub is a macOS Electron app for a single developer who runs many Claude
Code sessions, typically one per git worktree. It gathers every local session
into one list, restores any of them on demand, and offers one orchestrator
chat that drives them: targeted instructions to a single session ("for the
mileage session, add tests for the zero-rate case") and bulk actions across
many ("rebase all my open PRs onto main"). It also watches the pull request
behind each session and wakes the session when something happens.

Success means the developer stops juggling terminal tabs: every session and
its state is visible in one place, and one chat is enough to direct all of
them.

## Decisions taken during design

| Question | Decision |
|---|---|
| Where does a driven session run? | Relay owns it. It resumes the session headless through the Agent SDK. A session is driven from Relay or from a terminal, never both at once. |
| Which sessions are collected? | Local only: everything under `~/.claude/projects`. Cloud sessions are a later, separate source. |
| How much runs unattended? | The orchestrator shows a plan; after confirmation the sessions run in accept-edits mode. Destructive commands wait in an approvals queue. |
| Ongoing PR monitoring? | Yes. Relay polls `gh` in code (no tokens) and wakes a session only when an event happens. |
| How does the user talk to a session? | Only through the orchestrator. Session panels are read-only. |
| Can a running session be steered? | Yes. Sessions run in streaming-input mode; messages can be delivered mid-turn. |
| Process structure | Everything in the Electron app for v1, with the engine in a package that has no Electron imports so it can become a daemon later. |

## Stack

- Electron + Vite + React + TypeScript, packaged with Electron Forge.
- `@anthropic-ai/claude-agent-sdk` for both the sessions and the orchestrator.
- `gh` CLI for pull request state.
- SQLite through Node's built-in `node:sqlite` (`DatabaseSync`) for Relay's own state; Electron 44 bundles Node 24, so no native module rebuild is needed.
- Vitest for unit tests; Playwright for one Electron smoke test.
- pnpm workspaces.

## Architecture

```
apps/desktop        Electron main + preload + React renderer
packages/engine     Session engine, no Electron imports
packages/shared     Types shared by engine and renderer
```

The engine exposes one typed API, `RelayEngine`, plus an event emitter. The
Electron main process wraps it in IPC handlers; the renderer only ever sees
`RelayEngine`'s types. That boundary is the seam that lets the engine move
into a separate daemon without a rewrite.

### Engine components

Each component has one job and is testable on its own.

| Component | Does | Depends on |
|---|---|---|
| **SessionIndex** | Scans `~/.claude/projects/**/*.jsonl` and watches for changes. Extracts per session: id, cwd, git branch, title (first prompt or summary entry), last activity, message count. Only changed files are re-parsed. Sessions whose cwd no longer exists are marked stale. | filesystem, `git` |
| **SessionRunner** | Resumes one session via the SDK (`query({ resume, cwd, permissionMode: 'acceptEdits', canUseTool, ... })`) in streaming-input mode, streams messages, tracks state `idle \| running \| waiting-approval \| error`. One runner per active session, so a session cannot be driven twice. | Agent SDK (through an `AgentClient` interface) |
| **ApprovalQueue** | Receives `canUseTool` callbacks from runners and holds them until the user decides. Applies rules: file edits pass (accept-edits already covers them); destructive git commands (`push --force`, `reset --hard`, `clean`, `branch -D`, history rewrites), and any command whose paths fall outside the session cwd, wait for approval. Decisions can be "allow once", "deny" or "allow this pattern for this run". | SessionRunner |
| **Orchestrator** | A persistent SDK session whose tools are an in-process MCP server exposing Relay's operations (see below). It never reads transcripts directly. | Agent SDK, SessionIndex, SessionRunner, PrWatcher |
| **PrWatcher** | For each watch, runs `gh pr view --json` on an interval (default 5 minutes), diffs against the last snapshot, and emits `ci_failed`, `review_comment`, `base_moved` or `merged`. Events wake the session through SessionRunner. | `gh`, SessionRunner, Store |
| **Store** | SQLite: session metadata cache, orchestrator thread id, watches with last snapshots, bulk-run history, approval rules. | `node:sqlite` |

### Message delivery modes

Every message sent to a session carries a delivery mode and an origin.

- `steer` (default for the orchestrator): delivered now; the agent sees it at
  its next step, like typing into a running Claude Code session.
- `queue`: waits for the current turn to end. Default for watch events, so a
  CI failure does not derail work in progress.
- `interrupt`: aborts the current turn (`query.interrupt()`), then sends.

Origins are `user`, `orchestrator` and `watch:<event>`. The transcript shows
the origin on each message.

### Orchestrator tools

The orchestrator runs with `cwd` set to Relay's data directory, with no file
or shell tools. Its only tools are:

| Tool | Behaviour |
|---|---|
| `list_sessions({ filter? })` | id, repo, branch, title, state, last activity, PR number, running flag. |
| `get_session(id)` | The above plus the last N transcript entries, current tool call and pending approvals. |
| `send_to_session({ id, prompt, mode })` | Dispatches and returns a `messageId` at once. When the turn ends the engine posts a result summary back into the orchestrator thread. |
| `propose_bulk_action({ targets, prompt, mode })` | Renders a plan card and returns a `bulkRunId`. Nothing runs until the user confirms. The outcome arrives as an event. |
| `list_prs()` | `gh pr list --author @me --json`, joined to sessions by branch. |
| `create_watch(sessionId)` / `delete_watch(id)` | Manage PR watches. The PR number is derived from the session's branch. |
| `interrupt_session(id)` | Stops a runaway session. |

Rules in its system prompt: name the target session in the reply before
sending; ask when a target is ambiguous; more than one target always goes
through `propose_bulk_action`. Because the orchestrator cannot run shell or
edit files, the only way it changes anything is through a session, which is
where approvals live.

**Completion relay.** When any session turn ends or a watch fires, the engine
injects a compact event into the orchestrator thread. This lets the user ask
"what happened while I was away?" and get a grounded answer.

## Data flows

### Startup and restore

1. SessionIndex scans the transcripts and merges with the Store cache.
2. The renderer shows the session list grouped by repo, sorted by last
   activity. No session is resumed yet; a runner is created only when the
   orchestrator or a watch first sends to it. Idle sessions cost nothing.
3. The orchestrator thread is resumed from its stored id, so it keeps its
   memory across app restarts.

### Targeted instruction

1. The user types in the orchestrator chat.
2. The orchestrator calls `list_sessions`, picks the target and calls
   `send_to_session`. If the match is ambiguous it asks first.
3. SessionRunner resumes the session and streams output. The session panel
   updates live. When the turn ends, the orchestrator receives a summary and
   reports back.

### Bulk action

1. The orchestrator gathers targets (`list_sessions`, `list_prs`) and calls
   `propose_bulk_action`.
2. Relay renders a plan card: one row per session with the prompt it will
   receive. Rows can be unticked.
3. On confirm, the engine creates a `BulkRun` and dispatches to each runner
   with a concurrency cap (default 3).
4. Sessions run in accept-edits mode. Destructive commands land in the
   ApprovalQueue; the run card shows them in one list.
5. The card shows per-session state and a final summary, which also reaches
   the orchestrator through the completion relay.

### PR watch

1. `create_watch` stores the watch with its PR number.
2. PrWatcher polls, diffs, emits events.
3. `merged` closes the watch. Other events wake the session with a templated
   prompt containing the event details, in `queue` mode. The wake appears as
   a system notification and in the session panel.

## UI

Three columns plus a drawer.

- **Left — session list.** Grouped by repo. Each row: branch, title, state
  dot, PR badge with CI status, unread count. Search box. Stale sessions
  (cwd gone, or no activity for 30 days) are hidden behind a toggle.
- **Middle — orchestrator chat.** Plan cards and bulk-run cards render inline
  with tick boxes, confirm/cancel and per-row progress.
- **Right — session panel.** Read-only transcript built from the SDK stream
  and, for history before Relay took over, from the JSONL file. Origin tags on
  each message, current tool call, pending approvals at the top.
- **Approvals drawer.** Global list across sessions with the command, cwd and
  a diff where relevant. Allow once / deny / allow this pattern for this run.

Native notifications for: approval needed, watch event, bulk run finished,
session error.

## Error handling

- **Resume fails** (corrupt transcript, session too old, missing cwd): the
  session is marked `error` with the reason. The orchestrator receives that
  as the result and reports it instead of retrying.
- **SDK process dies mid-turn**: the runner marks the session `error`, keeps
  the partial transcript and offers "resume again". Its bulk-run row shows
  failed; the rest of the run continues.
- **`gh` unauthenticated or offline**: the watcher pauses with a banner,
  keeps its snapshots and resumes when `gh` works again. A failed poll never
  produces events.
- **Store loss**: everything except watches, the orchestrator thread id and
  approval rules is a cache rebuilt from the transcripts.
- **Quit with sessions running**: a confirm dialog lists them; on quit the
  runners are interrupted cleanly so transcripts stay resumable.

## Testing

**Engine (Vitest, plain Node).**

- SessionIndex: fixtures of anonymised real transcripts covering summary
  entries, sidechains, missing cwd and a truncated last line.
- SessionRunner: the SDK is injected through an `AgentClient` interface; tests
  use a scripted fake that yields messages and `canUseTool` calls. Covers
  state transitions, the three delivery modes, interrupt and process death.
- ApprovalQueue: table tests for the rule engine.
- PrWatcher: fake `gh` output; one event per transition, none on a failed
  poll.
- Orchestrator tools: each tool against a fake engine, plus the completion
  relay.

**Desktop.**

- Renderer components with Testing Library against `RelayEngine` types.
- One Playwright-for-Electron smoke test: launch, index fixtures, send to a
  fake session, see it in the panel.

**Not unit-tested.** The orchestrator's prompt behaviour is checked with a
small set of scripted scenarios ("rebase all", "tell X to Y", ambiguous
target) run manually before a release.

## Delivery

Electron Forge, unsigned local build (`pnpm make` → `.app` in `out/`). No
signing or auto-update until the app is shared.

## v1 milestones

Each is usable on its own.

1. Index, session list, read-only transcript viewer.
2. SessionRunner, approvals, "send to session" from a dev button.
3. Orchestrator chat with `list_sessions`, `get_session`, `send_to_session`.
4. Bulk actions with the plan card.
5. PR watches.

## Out of scope for v1

- Cloud (claude.ai/code) sessions.
- Attaching to sessions running in a terminal.
- A daemon or CLI; the engine package is shaped to allow it later.
- Direct chat with a session outside the orchestrator.
- Signing, notarisation, auto-update.
