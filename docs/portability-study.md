# Supporting other coding agents: a feasibility study

Date: 2026-09-24. Status: analysis only; no behaviour changed.

Relay Hub today drives one kind of agent: Claude Code, through the Agent SDK. This document
answers, tool by tool, whether OpenCode, GitHub Copilot, Codex CLI, Cursor, Aider and Gemini CLI
could be driven the same way, where our code is tied to Claude, what the smallest seam for a second
provider would be, and whether to build it now.

Everything about the other tools below is what their documentation or the local installation
showed on the date above; the places where only trying it would tell are marked as such.

## 1. Where we are coupled to Claude Code today

| Concern | Where | What is Claude-specific |
|---|---|---|
| Session discovery | `packages/engine/src/index/session-index.ts`, `apps/desktop/src/main.ts` (`~/.claude/projects` default) | The on-disk layout `~/.claude/projects/<escaped-cwd>/<id>.jsonl`, one file per session, watched with chokidar. |
| Transcript format | `packages/engine/src/transcript/parse-transcript.ts` | Claude Code's JSONL line types (`user`, `assistant`, `ai-title`, `custom-title`, `pr-link`, `relocated`, `continued-in`), the `isSidechain`/`isMeta` flags, `cwd`/`gitBranch` on each line, and Anthropic content blocks (`text`, `thinking`, `tool_use`, `tool_result`, `image`). `SessionSummary.prNumber`/`continuedIn` come from lines only Claude Code writes. |
| Driving a session | `packages/engine/src/runner/sdk-agent-client.ts` | `query()` in streaming-input mode; steer vs queue as `priority: 'now' \| 'next'`; `interrupt()`; result semantics (`user_message_uuids`, `queued_turn_count`, `terminal_reason: 'aborted_*'`); `permissionMode: 'acceptEdits'`; `settingSources`; `canUseTool`; the `PreToolUse` hook that forces our approvals past a session's own allow-list. |
| Turn accounting | `packages/engine/src/runner/session-runner.ts` | Generic-looking fields (`settledSendIds`, `queuedTurns`) whose meaning is exactly the SDK's one-result-per-turn, sends-fold-into-a-turn behaviour. |
| Who else holds a session | `packages/engine/src/runner/session-registry.ts`, `session-busy-error.ts`, the 15 s transcript-mtime window in `relay-engine.ts` | `~/.claude/sessions/<pid>.json`, its `entrypoint` (`cli` vs `sdk-*`) and `procStart` fields. Entirely Claude Code. |
| Approvals | `packages/engine/src/approvals/rules.ts`, `approval-queue.ts` | Claude's tool vocabulary: `Bash` with `command`; `Edit`/`Write`/`Read`/`MultiEdit`/`NotebookEdit` with `file_path`; the `blockedPath` hint. The *decision* (destructive git, outside cwd) is general; the *inputs* are Claude's. |
| Commands, skills, models | `packages/engine/src/commands/command-catalog.ts`, `sdk-agent-client.ts` | `supportedCommands()`, `supportedModels()`, `setModel()` on a live query; `/name` and `plugin:name` naming; skills and plugins loaded from Claude settings. |
| The orchestrator | `packages/engine/src/orchestrator/*`, `sdk-agent-client.ts` | Is itself a Claude session with an in-process MCP server (`createSdkMcpServer`). |
| PRs, branches, worktrees | `packages/engine/src/pr/*`, `packages/engine/src/git/worktrees.ts` | Nothing: `gh` and `git`. Any agent that leaves a branch behind fits. |
| The window | `apps/desktop/src/ui/*` | Renders the block kinds above; otherwise agent-neutral. |

Two things follow. First, the seam already half exists: `packages/engine/src/runner/agent-client.ts`
defines `AgentClient`, `AgentInput`, `AgentMessage` and `PermissionOutcome`, and the SDK client is
one implementation of it; tests already use a fake. Second, the orchestrator does not need to be
portable at all. It is Relay's own brain and can stay a Claude session while the sessions it drives
are anything.

## 2. General concepts versus Claude concepts

General to any agent worth driving: a session with a working directory and a history; a turn that
starts on a prompt and ends; tool calls with a name, an input and a result; the agent asking before
something risky; a way to cancel; a way to tell "working" from "idle"; a branch and possibly a PR.

Claude-specific in our code: the JSONL layout and line types; sidechains and meta lines; steer vs
queue as SDK priorities; the pid registry for locking; the exact tool names; slash commands, skills
and plugins as a namespace; the model list. Some of these have a general counterpart (ACP has
`allow_once`/`allow_always`; ACP agents report tool calls with statuses) and some do not (nobody
else has "steer a running turn" or a pid registry).

The seam therefore sits at: **discover** (index + parse), **drive** (send, cancel, observe),
**presence** (is someone else holding it), **capabilities** (commands, models), and **approve**
(classify a tool call). Everything above those five is already agent-neutral.

## 3. Feasibility per tool

Legend for "drive": can we send an instruction, cancel, and be told when it is working, when it
wants approval, and what it did.

### OpenCode — installed here (1.15.0)

- **Persisted sessions**: yes, readable. `~/.local/share/opencode/opencode.db` (SQLite) holds
  `session` (1,182 rows on this machine, with `directory`, `title`, `time_updated`, `model`),
  `message` and `part` (JSON `data`, typed parts), plus a `permission` table; a file mirror lives
  under `storage/`. `opencode export <id>` gives JSON. Sessions for `factorial-agent` and
  `factorial/mobile` are already there.
- **Drive**: yes. `opencode serve` is a local HTTP server with an OpenAPI spec: `GET /session`,
  `GET /session/status`, `POST /session/:id/message` (or `prompt_async`), `POST /session/:id/abort`,
  `POST /session/:id/permissions/:permissionID` with `{ response, remember? }`, and an SSE stream at
  `GET /event`. It also speaks ACP (`opencode acp`).
- **Observe**: status per session over the API and bus events over SSE.
- **Unknown until tried**: whether a message can reach a turn that is already running (our
  "steer"); the exact event names for a pending permission; whether `abort` maps cleanly onto our
  interrupt-then-resume.
- **Verdict**: the best fit of the set, and testable on this machine today.

### Codex CLI

- **Persisted sessions**: yes. Rollouts at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (zstd
  compressed), described as the durable, replayable representation of a thread; threads can be
  resumed by id, forked and archived.
- **Drive**: yes. The app-server is a long-lived JSON-RPC 2.0 process over stdio (also websocket)
  with threads and turns, used by every Codex surface; `codex exec --json` is the one-shot lane;
  `codex-acp` exposes it over ACP.
- **Observe**: turn events over the same JSON-RPC connection.
- **Unknown until tried**: the approval request shape and whether a turn can be interrupted without
  losing it; the compressed rollout format for our indexer.
- **Verdict**: feasible; second after OpenCode, mainly because nothing of it is installed here.

### Gemini CLI

- **Persisted sessions**: sessions can be resumed by id, but the on-disk format is not documented in
  what I found; there is an open request to have headless JSON output carry the session id.
- **Drive**: yes, two ways. Headless `-p ... --output-format json` (one shot, no interrupt) and a
  native ACP mode (JSON-RPC over stdio) built for programmatic control.
- **Observe**: through ACP updates and permission requests.
- **Verdict**: feasible through ACP; discovery of existing sessions on disk is the gap.

### GitHub Copilot CLI

- **Persisted sessions**: yes, when the SDK's persistence is enabled; sessions resume across
  restarts and even across clients by a session id you supply.
- **Drive**: yes. `@github/copilot-sdk` (TypeScript) talks JSON-RPC to `copilot --headless --port N`;
  ACP is supported natively, in public preview.
- **Observe**: through the SDK's session events.
- **Risk**: churn. `--headless --stdio` was removed without deprecation and broke downstream
  integrations; the docs carry an SDK/CLI compatibility page for a reason.
- **Verdict**: feasible, with the highest chance of breaking under us.

### Cursor CLI (`cursor-agent`) — installed here

- **Persisted sessions**: resumable (`agent ls`, `--resume <id>`), but where and in what form they
  are stored is not documented; likely cloud-backed. Not confirmed readable from disk.
- **Drive**: one shot only. `--print --output-format stream-json` emits typed events (`system`,
  `assistant`, `tool_call` started/completed, `result`) for a single run; there is no server and no
  interrupt other than killing the process.
- **Observe**: within a run, yes; between runs, no.
- **Verdict**: partial. We could start work and read its stream; we could not steer, interrupt
  cleanly, or index its history.

### Aider

- **Persisted sessions**: a Markdown chat history file per repository; no session identity.
- **Drive**: a Python API (`Coder.create`, `coder.run`) that its own docs say is unsupported and may
  change without notice; no server, no protocol, no interrupt, no permission model beyond `--yes`.
- **Verdict**: out of reach for this app without writing and maintaining a Python shim ourselves.

### The common denominator: ACP

Gemini CLI, Copilot CLI, Goose, Cline and OpenHands implement the Agent Client Protocol natively;
Claude Code and Codex are reachable through adapters; OpenCode ships `opencode acp`. The protocol
gives us `session/new` (baseline), `session/load` and `session/resume` (optional), `session/prompt`,
`session/update`, `session/cancel`, `session/request_permission` with `allow_once`, `allow_always`,
`reject_once`, `reject_always`, and tool call statuses `pending`/`in_progress`/`completed`/`failed`.

It also tells us what a second provider would cost us in features: **ACP has no session listing**,
so discovery stays per tool; and **a prompt cannot be sent while a turn is in flight**, so "steer"
becomes "queue" for every ACP agent. Whether a given agent honours `session/load` is a capability
flag we would read at runtime.

## 4. The smallest seam, and what it costs

Keep the orchestrator as it is. Introduce one interface behind which the five concerns live:

```ts
interface SessionProvider {
  readonly id: 'claude' | 'opencode' | ...;
  discover(): SessionSource;                 // lists sessions, reads a transcript, watches for change
  driver(): AgentClient;                     // exists today; steer may degrade to queue
  presence(): SessionRegistry;               // exists today; may be "unknown" for a provider
  capabilities(cwd): { commands, models };   // may be empty
  classify(toolCall): ToolCallShape;         // maps the provider's tool names onto our rules
}
```

Concretely, the changes would be: add `provider` to `SessionSummary` and thread it through the
index, the engine's runner creation and the window's grouping; move the Claude constants
(`~/.claude/projects`, `~/.claude/sessions`, the tool names in `rules.ts`) behind a `claude`
module; make `rules.ts` take a normalised call (`{ kind: 'shell', command }` or
`{ kind: 'file', path }`) rather than Claude's names; give `SessionRunner` a capability object
so it knows whether steering exists instead of assuming it; and add a second `SessionIndex`
source type. The renderer would need a provider badge and nothing else.

Cost: the seam itself is a few days of careful refactoring with the existing tests as the net.
The first real provider (OpenCode over its HTTP API) is more like one to two weeks including a
transcript reader for its SQLite and the parts of its event stream we would have to discover by
trying. Those are estimates for an unfamiliar API, not commitments.

Risk and loss: every provider we add is a moving target we do not control (Copilot has already
broken its own SDK once); steering becomes queueing for anything that is not Claude; the busy
guard degrades to "unknown" where there is no pid registry, which means either trusting the
provider's own status or accepting the double-drive risk the guard exists to prevent; and the
approval rules only protect what we can classify, so an unfamiliar tool name is a hole until it
is mapped. Not doing it costs nothing today: no current feature is blocked by being Claude-only.

## 5. Recommendation

**Prepare cheaply now; do not build it yet.** The cheap preparation is exactly the part that
reduces future cost without adding a second provider: put `provider: 'claude'` on
`SessionSummary`, gather the Claude constants into one module, and make the approval rules work on a
normalised tool-call shape. Each is a small, mechanical refactor covered by tests we already have,
and each is a change I would ask about before making, as agreed.

If and when a second provider is wanted, **target OpenCode first**: it is on this machine, its
sessions are already readable in SQLite, its server has abort and permission endpoints and an
event stream, and it also speaks ACP, so it can prove both the direct route and the protocol
route. Codex second, through its app-server. Gemini and Copilot after, through ACP only. Cursor
only as a "start work and watch" integration. Aider not at all.

## Sources

- OpenCode: local installation (`opencode --help`, `~/.local/share/opencode/opencode.db`);
  [Server docs](https://opencode.ai/docs/server/); [SSE on the REST API](https://github.com/anomalyco/opencode/issues/13416)
- Codex: [App-server complete guide](https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/);
  [Session lifecycle and rollout persistence](https://codex.danielvaughan.com/2026/06/08/codex-cli-session-lifecycle-archive-resume-fork-rollout-persistence-management/);
  [Controlling Codex via JSON-RPC](https://dev.to/version1/controlling-codex-via-json-rpc-with-codex-app-server-1moc)
- Gemini CLI: [Headless mode](https://geminicli.com/docs/cli/headless/); [ACP mode](https://geminicli.com/docs/cli/acp-mode/);
  [headless output should carry the session id](https://github.com/google-gemini/gemini-cli/issues/14435)
- Copilot: [Copilot SDK on npm](https://www.npmjs.com/package/@github/copilot-sdk);
  [Session resume and persistence](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence);
  [SDK and CLI compatibility](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/sdk-and-cli-compatibility);
  [--headless --stdio removed](https://github.com/github/copilot-cli/issues/1606)
- Cursor: local `cursor-agent --help`; [Headless CLI](https://cursor.com/docs/cli/headless); [Output format](https://cursor.com/docs/cli/reference/output-format)
- Aider: [Scripting aider](https://aider.chat/docs/scripting.html)
- ACP: [Introduction](https://agentclientprotocol.com/get-started/introduction); [Prompt turn](https://agentclientprotocol.com/protocol/prompt-turn);
  [Tool calls](https://agentclientprotocol.com/protocol/tool-calls); [Session setup](https://agentclientprotocol.com/protocol/session-setup);
  [Zed on ACP](https://zed.dev/acp); [JetBrains on ACP](https://www.jetbrains.com/acp/)
