# Relay Hub — Milestone 1: session index and viewer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Electron app that lists every local Claude Code session grouped by repo and shows any session's transcript read-only.

**Architecture:** A pnpm workspace with `packages/shared` (types), `packages/engine` (transcript parser, git info, SQLite cache, `SessionIndex`, `RelayEngine` facade; no Electron imports) and `apps/desktop` (Electron Forge + Vite + React). The main process owns one `RelayEngine` and exposes it over IPC; the renderer renders `SessionSummary` and `TranscriptEntry` values and nothing else.

**Tech Stack:** pnpm 11, TypeScript 5, Electron 44 (bundled Node 24), Electron Forge 7.11 with `@electron-forge/plugin-vite`, Vite 8, React 19, Vitest 5, chokidar 5, `node:sqlite` (`DatabaseSync`), Playwright for one Electron smoke test.

**Spec:** `docs/superpowers/specs/2026-09-23-relay-hub-design.md`

## Global Constraints

- `packages/engine` and `packages/shared` must not import from `electron` or from `apps/desktop`.
- Node `>= 22.13` locally (`node:sqlite` unflagged). Electron 44 bundles Node 24.
- Imports use the workspace package names `@relay/shared` and `@relay/engine`; no relative imports across packages.
- `packages/*` are ESM (`"type": "module"`); `apps/desktop` keeps the Forge template's CommonJS main bundle (`__dirname`, not `import.meta`). Tests import from `vitest`, never globals.
- Sessions are read from `~/.claude/projects/**/*.jsonl`; the `projectsDir` is always a constructor parameter so tests point it at fixtures.
- Titles: `custom-title` > `ai-title` > first human prompt (trimmed to 80 chars) > `"Untitled session"`.
- A session is **stale** when its cwd no longer exists or its last activity is older than 30 days.
- Sessions are grouped by **repo**: the directory name of the git common dir's parent (so worktrees group under their main repo), falling back to the cwd basename when git is unavailable.
- No ticket ids in code or comments. Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

Inputs the spec implies that a person will hit, each pinned by a test in the owning task:

1. **A transcript being written right now** — its last line is cut mid-JSON. The parser must skip that line and index the rest (Task 3).
2. **A session with no human prompt** (only sidechain, meta or tool-result entries). The title must fall back to `"Untitled session"` and nothing throws (Task 3).
3. **Stray files in a project dir** — `subagents/` directories and non-`.jsonl` files sit next to transcripts. The index must ignore them (Task 6).
4. **A cwd that was deleted** (worktree removed). `git` must not be called, `cwdExists` is false, `branch` is null, the session is still listed as stale (Task 6).
5. **A transcript changing while the app is open.** The watcher must re-parse only the changed file and emit one `changed` event after a debounce, not one per write (Task 6).

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.gitignore`, `tsconfig.base.json`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Create: `packages/engine/package.json`, `packages/engine/tsconfig.json`, `packages/engine/vitest.config.ts`, `packages/engine/src/index.ts`, `packages/engine/test/smoke.test.ts`

**Interfaces:**
- Produces: package names `@relay/shared`, `@relay/engine`; root scripts `pnpm test`, `pnpm typecheck`.

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "relay-hub",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.13" },
  "scripts": {
    "test": "pnpm -r --if-present test",
    "typecheck": "pnpm -r --if-present typecheck",
    "dev": "pnpm --filter @relay/desktop start"
  },
  "devDependencies": { "typescript": "^5.9.0" }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - apps/*
```

`.npmrc`:
```
node-linker=hoisted
```
(Electron Forge packaging needs a flat `node_modules`.)

`.gitignore`:
```
node_modules
dist
out
.vite
*.log
.DS_Store
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "types": ["node"]
  }
}
```

- [ ] **Step 2: `packages/shared`**

`packages/shared/package.json`:
```json
{
  "name": "@relay/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "typecheck": "tsc --noEmit" },
  "devDependencies": { "@types/node": "^24.0.0", "typescript": "^5.9.0" }
}
```

`packages/shared/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/shared/src/index.ts`:
```ts
export {};
```

- [ ] **Step 3: `packages/engine`**

`packages/engine/package.json`:
```json
{
  "name": "@relay/engine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "@relay/shared": "workspace:*", "chokidar": "^5.0.0" },
  "devDependencies": { "@types/node": "^24.0.0", "typescript": "^5.9.0", "vitest": "^5.0.0" }
}
```

`packages/engine/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/engine/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
```

`packages/engine/src/index.ts`:
```ts
export {};
```

`packages/engine/test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

describe('toolchain', () => {
  it('has node:sqlite', () => {
    const db = new DatabaseSync(':memory:');
    expect(db.prepare('select 1 as one').get()).toEqual({ one: 1 });
  });
});
```

- [ ] **Step 4: Install and verify**

Run: `cd ~/code/relay-hub && pnpm install && pnpm test && pnpm typecheck`
Expected: 1 test passes (an `ExperimentalWarning` about SQLite on Node 22 is fine); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: pnpm workspace with shared and engine packages"
```

---

### Task 2: Shared types

**Files:**
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/src/session.ts`, `packages/shared/src/transcript.ts`

**Interfaces:**
- Produces: `SessionSummary`, `TranscriptBlock`, `TranscriptEntry` used by every later task.

- [ ] **Step 1: Write the types**

`packages/shared/src/session.ts`:
```ts
/** One Claude Code session as shown in the session list. */
export interface SessionSummary {
  id: string;
  filePath: string;
  cwd: string;
  cwdExists: boolean;
  /** Directory name of the main repo; worktrees share it. */
  repo: string;
  branch: string | null;
  title: string;
  /** ISO timestamp of the newest user or assistant entry. */
  lastActivity: string;
  /** Count of non-sidechain user and assistant entries. */
  messageCount: number;
  prNumber: number | null;
  prUrl: string | null;
  /** Session id this one was continued in, if any. */
  continuedIn: string | null;
  isStale: boolean;
}
```

`packages/shared/src/transcript.ts`:
```ts
export type TranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking' }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; text: string; isError: boolean }
  | { kind: 'image' };

/** A user or assistant message, flattened for rendering. */
export interface TranscriptEntry {
  uuid: string;
  role: 'user' | 'assistant';
  timestamp: string;
  isSidechain: boolean;
  isMeta: boolean;
  blocks: TranscriptBlock[];
}
```

`packages/shared/src/index.ts`:
```ts
export type { SessionSummary } from './session';
export type { TranscriptBlock, TranscriptEntry } from './transcript';
```

- [ ] **Step 2: Typecheck and commit**

Run: `pnpm typecheck`
Expected: clean.

```bash
git add packages/shared
git commit -m "feat(shared): session and transcript types"
```

---

### Task 3: Transcript parser

**Files:**
- Create: `packages/engine/src/transcript/parse-transcript.ts`
- Create: `packages/engine/test/fixtures/basic.jsonl`, `packages/engine/test/fixtures/truncated.jsonl`, `packages/engine/test/fixtures/no-prompt.jsonl`
- Create: `packages/engine/test/transcript/parse-transcript.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ParsedTranscript {
    sessionId: string | null;
    cwd: string | null;
    gitBranch: string | null;
    title: string;
    lastActivity: string | null;
    messageCount: number;
    prNumber: number | null;
    prUrl: string | null;
    continuedIn: string | null;
    entries: TranscriptEntry[];
  }
  function parseTranscriptLines(lines: Iterable<string>): ParsedTranscript;
  function readTranscript(filePath: string): Promise<ParsedTranscript>;
  ```

Transcript facts (from real files, Claude Code 2.1.x): every line is one JSON object with a `type`. `user` and `assistant` entries carry `uuid`, `timestamp`, `cwd`, `gitBranch`, `isSidechain`, optional `isMeta`, and `message.content` (a string for typed prompts, else an array of `{type: 'text'|'tool_use'|'tool_result'|'thinking'|'image'}` blocks). Session-level entries: `{"type":"ai-title","aiTitle"}`, `{"type":"custom-title","customTitle"}`, `{"type":"pr-link","prNumber","prUrl"}`, `{"type":"relocated","relocatedCwd"}`, `{"type":"continued-in","continuedInSessionId"}`. Other types (`attachment`, `system`, `file-history-snapshot`, `queue-operation`, `mode`, …) are ignored.

- [ ] **Step 1: Fixtures**

`packages/engine/test/fixtures/basic.jsonl` (one JSON object per line):
```
{"type":"permission-mode","permissionMode":"auto","sessionId":"s-basic"}
{"type":"ai-title","aiTitle":"Add tests for the zero-rate case","sessionId":"s-basic"}
{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-09-20T10:00:00.000Z","cwd":"/repo/wt-a","gitBranch":"feat/a","sessionId":"s-basic","message":{"role":"user","content":"add tests for the zero-rate case please"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-09-20T10:00:05.000Z","cwd":"/repo/wt-a","gitBranch":"feat/a","sessionId":"s-basic","message":{"role":"assistant","content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"Looking at the tests."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/repo/wt-a/a.ts"}}]}}
{"type":"user","uuid":"u2","parentUuid":"a1","isSidechain":false,"timestamp":"2026-09-20T10:00:06.000Z","cwd":"/repo/wt-a","gitBranch":"feat/a","sessionId":"s-basic","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"export const a = 1;"}]}}
{"type":"user","uuid":"side1","parentUuid":null,"isSidechain":true,"timestamp":"2026-09-20T10:00:07.000Z","cwd":"/repo/wt-a","gitBranch":"feat/a","sessionId":"s-basic","message":{"role":"user","content":"subagent prompt"}}
{"type":"assistant","uuid":"a2","parentUuid":"u2","isSidechain":false,"timestamp":"2026-09-20T10:01:00.000Z","cwd":"/repo/wt-a","gitBranch":"feat/a","sessionId":"s-basic","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}
{"type":"pr-link","sessionId":"s-basic","prNumber":42,"prUrl":"https://github.com/org/repo/pull/42","prRepository":"org/repo","timestamp":"2026-09-20T10:01:30.000Z"}
{"type":"system","subtype":"turn_duration","durationMs":1,"uuid":"sys1","timestamp":"2026-09-20T10:01:31.000Z","sessionId":"s-basic","isSidechain":false}
```

`packages/engine/test/fixtures/truncated.jsonl` — same first three lines as `basic.jsonl` but with a `custom-title` line and a cut-off final line:
```
{"type":"custom-title","customTitle":"My own title","sessionId":"s-trunc"}
{"type":"ai-title","aiTitle":"Ignored ai title","sessionId":"s-trunc"}
{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-09-21T08:00:00.000Z","cwd":"/repo/wt-b","gitBranch":"feat/b","sessionId":"s-trunc","message":{"role":"user","content":"hello"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-09-21T08:00:0
```
(The last line must have no trailing newline and be cut exactly as shown.)

`packages/engine/test/fixtures/no-prompt.jsonl`:
```
{"type":"user","uuid":"m1","parentUuid":null,"isSidechain":false,"isMeta":true,"timestamp":"2026-09-22T08:00:00.000Z","cwd":"/repo/wt-c","gitBranch":"main","sessionId":"s-noprompt","message":{"role":"user","content":"<system-reminder>context</system-reminder>"}}
{"type":"user","uuid":"t1","parentUuid":"m1","isSidechain":false,"timestamp":"2026-09-22T08:00:01.000Z","cwd":"/repo/wt-c","gitBranch":"main","sessionId":"s-noprompt","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}
{"type":"relocated","sessionId":"s-noprompt","relocatedCwd":"/repo/wt-c-moved"}
```

- [ ] **Step 2: Failing tests**

`packages/engine/test/transcript/parse-transcript.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readTranscript } from '../../src/transcript/parse-transcript';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe('readTranscript', () => {
  it('extracts session metadata from a complete transcript', async () => {
    const t = await readTranscript(fixture('basic.jsonl'));
    expect(t.sessionId).toBe('s-basic');
    expect(t.cwd).toBe('/repo/wt-a');
    expect(t.gitBranch).toBe('feat/a');
    expect(t.title).toBe('Add tests for the zero-rate case');
    expect(t.lastActivity).toBe('2026-09-20T10:01:00.000Z');
    expect(t.messageCount).toBe(4);
    expect(t.prNumber).toBe(42);
    expect(t.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(t.continuedIn).toBeNull();
  });

  it('flattens message content into blocks and keeps sidechain flags', async () => {
    const t = await readTranscript(fixture('basic.jsonl'));
    expect(t.entries.map((e) => e.uuid)).toEqual(['u1', 'a1', 'u2', 'side1', 'a2']);
    expect(t.entries[0]?.blocks).toEqual([{ kind: 'text', text: 'add tests for the zero-rate case please' }]);
    expect(t.entries[1]?.blocks).toEqual([
      { kind: 'thinking' },
      { kind: 'text', text: 'Looking at the tests.' },
      { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/wt-a/a.ts' } },
    ]);
    expect(t.entries[2]?.blocks).toEqual([
      { kind: 'tool_result', toolUseId: 't1', text: 'export const a = 1;', isError: false },
    ]);
    expect(t.entries[3]?.isSidechain).toBe(true);
  });

  it('prefers the custom title and skips a truncated last line', async () => {
    const t = await readTranscript(fixture('truncated.jsonl'));
    expect(t.title).toBe('My own title');
    expect(t.entries).toHaveLength(1);
    expect(t.lastActivity).toBe('2026-09-21T08:00:00.000Z');
  });

  it('falls back to an untitled session and honours relocation', async () => {
    const t = await readTranscript(fixture('no-prompt.jsonl'));
    expect(t.title).toBe('Untitled session');
    expect(t.cwd).toBe('/repo/wt-c-moved');
    expect(t.entries[0]?.isMeta).toBe(true);
  });

  it('derives the title from the first human prompt, trimmed to 80 chars', () => {
    const long = 'x'.repeat(100);
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u', isSidechain: false, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/c', sessionId: 's', message: { role: 'user', content: long } }),
    ];
    const t = parseTranscriptLines(lines);
    expect(t.title).toBe('x'.repeat(80));
  });
});
```
Add `parseTranscriptLines` to the import line.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @relay/engine test`
Expected: FAIL, cannot resolve `../../src/transcript/parse-transcript`.

- [ ] **Step 4: Implementation**

`packages/engine/src/transcript/parse-transcript.ts`:
```ts
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { TranscriptBlock, TranscriptEntry } from '@relay/shared';

export interface ParsedTranscript {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  title: string;
  lastActivity: string | null;
  messageCount: number;
  prNumber: number | null;
  prUrl: string | null;
  continuedIn: string | null;
  entries: TranscriptEntry[];
}

const TITLE_MAX = 80;
const UNTITLED = 'Untitled session';

type RawBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

type RawLine = {
  type?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { role?: string; content?: string | RawBlock[] };
  aiTitle?: string;
  customTitle?: string;
  prNumber?: number;
  prUrl?: string;
  relocatedCwd?: string;
  continuedInSessionId?: string;
};

function toBlocks(content: string | RawBlock[] | undefined): TranscriptBlock[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: TranscriptBlock[] = [];
  for (const b of content) {
    switch (b.type) {
      case 'text':
        blocks.push({ kind: 'text', text: b.text ?? '' });
        break;
      case 'thinking':
        blocks.push({ kind: 'thinking' });
        break;
      case 'tool_use':
        blocks.push({ kind: 'tool_use', id: b.id ?? '', name: b.name ?? '', input: b.input });
        break;
      case 'tool_result':
        blocks.push({
          kind: 'tool_result',
          toolUseId: b.tool_use_id ?? '',
          text: toolResultText(b.content),
          isError: b.is_error === true,
        });
        break;
      case 'image':
        blocks.push({ kind: 'image' });
        break;
    }
  }
  return blocks;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: RawBlock) => (c.type === 'text' ? c.text ?? '' : '[image]'))
      .join('\n');
  }
  return '';
}

function firstText(blocks: TranscriptBlock[]): string | null {
  const t = blocks.find((b) => b.kind === 'text');
  return t && t.kind === 'text' ? t.text : null;
}

/** Parses transcript lines; unparsable lines (e.g. a write in progress) are skipped. */
export function parseTranscriptLines(lines: Iterable<string>): ParsedTranscript {
  const out: ParsedTranscript = {
    sessionId: null, cwd: null, gitBranch: null, title: UNTITLED, lastActivity: null,
    messageCount: 0, prNumber: null, prUrl: null, continuedIn: null, entries: [],
  };
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  let promptTitle: string | null = null;
  let relocatedCwd: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: RawLine;
    try {
      raw = JSON.parse(line) as RawLine;
    } catch {
      continue;
    }
    out.sessionId ??= raw.sessionId ?? null;
    switch (raw.type) {
      case 'ai-title': aiTitle = raw.aiTitle ?? aiTitle; break;
      case 'custom-title': customTitle = raw.customTitle ?? customTitle; break;
      case 'pr-link':
        out.prNumber = raw.prNumber ?? out.prNumber;
        out.prUrl = raw.prUrl ?? out.prUrl;
        break;
      case 'relocated': relocatedCwd = raw.relocatedCwd ?? relocatedCwd; break;
      case 'continued-in': out.continuedIn = raw.continuedInSessionId ?? out.continuedIn; break;
      case 'user':
      case 'assistant': {
        if (!raw.uuid || !raw.timestamp) break;
        const entry: TranscriptEntry = {
          uuid: raw.uuid,
          role: raw.type,
          timestamp: raw.timestamp,
          isSidechain: raw.isSidechain === true,
          isMeta: raw.isMeta === true,
          blocks: toBlocks(raw.message?.content),
        };
        out.entries.push(entry);
        if (!entry.isSidechain) {
          out.messageCount += 1;
          out.lastActivity = raw.timestamp;
          if (raw.cwd) out.cwd = raw.cwd;
          if (raw.gitBranch) out.gitBranch = raw.gitBranch;
          if (promptTitle === null && entry.role === 'user' && !entry.isMeta && typeof raw.message?.content === 'string') {
            promptTitle = firstText(entry.blocks);
          }
        }
        break;
      }
    }
  }

  if (relocatedCwd) out.cwd = relocatedCwd;
  const title = customTitle ?? aiTitle ?? promptTitle;
  out.title = title ? title.trim().slice(0, TITLE_MAX) || UNTITLED : UNTITLED;
  return out;
}

/** Streams a JSONL transcript from disk; large files are never read whole. */
export async function readTranscript(filePath: string): Promise<ParsedTranscript> {
  const lines: string[] = [];
  const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) lines.push(line);
  return parseTranscriptLines(lines);
}
```

`packages/engine/src/index.ts`:
```ts
export { parseTranscriptLines, readTranscript } from './transcript/parse-transcript';
export type { ParsedTranscript } from './transcript/parse-transcript';
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @relay/engine test`
Expected: all parse tests PASS. If the "truncated" test fails on `entries.length`, check the fixture really ends mid-object with no newline.

- [ ] **Step 6: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): stream and parse Claude Code JSONL transcripts"
```

---

### Task 4: Git info provider

**Files:**
- Create: `packages/engine/src/git/git-info.ts`
- Create: `packages/engine/test/git/git-info.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  interface GitInfo { branch: string | null; repo: string | null }
  interface GitInfoProvider { inspect(cwd: string): Promise<GitInfo> }
  class ExecGitInfoProvider implements GitInfoProvider  // runs `git`
  ```
  `repo` = basename of the parent of `git rev-parse --git-common-dir`; for a worktree of `~/code/factorial` that is `factorial`.

- [ ] **Step 1: Failing test** (uses a real temporary repo, since the provider's only job is talking to git)

`packages/engine/test/git/git-info.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExecGitInfoProvider } from '../../src/git/git-info';

const run = promisify(execFile);

describe('ExecGitInfoProvider', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'relay-git-'));
    const main = join(root, 'myrepo');
    await run('git', ['init', '-q', '-b', 'main', main]);
    await run('git', ['-C', main, 'commit', '-q', '--allow-empty', '-m', 'init'], {
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
    await run('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'feat/x', join(root, 'wt-x')]);
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('reports branch and main repo name for the main checkout', async () => {
    const info = await new ExecGitInfoProvider().inspect(join(root, 'myrepo'));
    expect(info).toEqual({ branch: 'main', repo: 'myrepo' });
  });

  it('groups a worktree under its main repo', async () => {
    const info = await new ExecGitInfoProvider().inspect(join(root, 'wt-x'));
    expect(info).toEqual({ branch: 'feat/x', repo: 'myrepo' });
  });

  it('returns nulls outside a repo instead of throwing', async () => {
    const info = await new ExecGitInfoProvider().inspect(tmpdir());
    expect(info).toEqual({ branch: null, repo: null });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @relay/engine test git-info`
Expected: FAIL, module not found.

- [ ] **Step 3: Implementation**

`packages/engine/src/git/git-info.ts`:
```ts
import { execFile } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitInfo {
  branch: string | null;
  /** Directory name of the main repository; shared by all its worktrees. */
  repo: string | null;
}

export interface GitInfoProvider {
  inspect(cwd: string): Promise<GitInfo>;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 5_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Reads branch and repo identity by invoking the `git` binary. */
export class ExecGitInfoProvider implements GitInfoProvider {
  async inspect(cwd: string): Promise<GitInfo> {
    const [branch, commonDir] = await Promise.all([
      git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(cwd, ['rev-parse', '--git-common-dir']),
    ]);
    if (commonDir === null) return { branch: null, repo: null };
    const repo = basename(dirname(resolve(cwd, commonDir)));
    return { branch, repo };
  }
}
```

Add to `packages/engine/src/index.ts`:
```ts
export { ExecGitInfoProvider } from './git/git-info';
export type { GitInfo, GitInfoProvider } from './git/git-info';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @relay/engine test git-info`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): git branch and repo identity provider"
```

---

### Task 5: Session store (SQLite cache)

**Files:**
- Create: `packages/engine/src/store/session-store.ts`
- Create: `packages/engine/test/store/session-store.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  interface CachedSession { summary: SessionSummary; mtimeMs: number; size: number }
  class SessionStore {
    constructor(path: string)             // ':memory:' in tests
    get(filePath: string): CachedSession | null
    upsert(entry: CachedSession): void
    all(): CachedSession[]
    removeMissing(presentFilePaths: string[]): void
    close(): void
  }
  ```
  The cache key is `summary.filePath`. `mtimeMs`/`size` decide whether the index re-parses.

- [ ] **Step 1: Failing test**

`packages/engine/test/store/session-store.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@relay/shared';
import { SessionStore } from '../../src/store/session-store';

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1', filePath: '/p/s1.jsonl', cwd: '/repo', cwdExists: true, repo: 'repo', branch: 'main',
  title: 'T', lastActivity: '2026-09-20T10:00:00.000Z', messageCount: 3, prNumber: null, prUrl: null,
  continuedIn: null, isStale: false, ...over,
});

describe('SessionStore', () => {
  it('round-trips a session and reports the cached file signature', () => {
    const store = new SessionStore(':memory:');
    store.upsert({ summary: summary(), mtimeMs: 10, size: 100 });
    expect(store.get('/p/s1.jsonl')).toEqual({ summary: summary(), mtimeMs: 10, size: 100 });
    expect(store.get('/p/none.jsonl')).toBeNull();
  });

  it('upsert replaces by file path', () => {
    const store = new SessionStore(':memory:');
    store.upsert({ summary: summary({ title: 'old' }), mtimeMs: 1, size: 1 });
    store.upsert({ summary: summary({ title: 'new' }), mtimeMs: 2, size: 2 });
    expect(store.all()).toHaveLength(1);
    expect(store.get('/p/s1.jsonl')?.summary.title).toBe('new');
  });

  it('removes sessions whose file is gone', () => {
    const store = new SessionStore(':memory:');
    store.upsert({ summary: summary(), mtimeMs: 1, size: 1 });
    store.upsert({ summary: summary({ id: 's2', filePath: '/p/s2.jsonl' }), mtimeMs: 1, size: 1 });
    store.removeMissing(['/p/s2.jsonl']);
    expect(store.all().map((c) => c.summary.id)).toEqual(['s2']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @relay/engine test session-store`
Expected: FAIL, module not found.

- [ ] **Step 3: Implementation**

`packages/engine/src/store/session-store.ts`:
```ts
import { DatabaseSync } from 'node:sqlite';
import type { SessionSummary } from '@relay/shared';

export interface CachedSession {
  summary: SessionSummary;
  mtimeMs: number;
  size: number;
}

type Row = { file_path: string; mtime_ms: number; size: number; summary: string };

/** Persists parsed session summaries keyed by transcript path, with the file signature used to skip re-parsing. */
export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      create table if not exists sessions (
        file_path text primary key,
        mtime_ms real not null,
        size integer not null,
        summary text not null
      )
    `);
  }

  get(filePath: string): CachedSession | null {
    const row = this.db.prepare('select * from sessions where file_path = ?').get(filePath) as Row | undefined;
    return row ? toCached(row) : null;
  }

  upsert(entry: CachedSession): void {
    this.db
      .prepare(
        `insert into sessions (file_path, mtime_ms, size, summary) values (?, ?, ?, ?)
         on conflict(file_path) do update set mtime_ms = excluded.mtime_ms, size = excluded.size, summary = excluded.summary`,
      )
      .run(entry.summary.filePath, entry.mtimeMs, entry.size, JSON.stringify(entry.summary));
  }

  all(): CachedSession[] {
    return (this.db.prepare('select * from sessions').all() as Row[]).map(toCached);
  }

  removeMissing(presentFilePaths: string[]): void {
    const present = new Set(presentFilePaths);
    const del = this.db.prepare('delete from sessions where file_path = ?');
    for (const row of this.db.prepare('select file_path from sessions').all() as Pick<Row, 'file_path'>[]) {
      if (!present.has(row.file_path)) del.run(row.file_path);
    }
  }

  close(): void {
    this.db.close();
  }
}

function toCached(row: Row): CachedSession {
  return { summary: JSON.parse(row.summary) as SessionSummary, mtimeMs: row.mtime_ms, size: row.size };
}
```

Add to `packages/engine/src/index.ts`:
```ts
export { SessionStore } from './store/session-store';
export type { CachedSession } from './store/session-store';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @relay/engine test session-store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): SQLite session cache keyed by transcript path"
```

---

### Task 6: SessionIndex

**Files:**
- Create: `packages/engine/src/index/session-index.ts`
- Create: `packages/engine/test/index/session-index.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Consumes: `readTranscript`, `SessionStore`, `GitInfoProvider`.
- Produces:
  ```ts
  interface SessionIndexOptions {
    projectsDir: string;
    store: SessionStore;
    git: GitInfoProvider;
    now?: () => Date;          // for stale tests
    debounceMs?: number;       // default 300
  }
  class SessionIndex extends EventEmitter<{ changed: [SessionSummary[]] }> {
    constructor(opts: SessionIndexOptions)
    scan(): Promise<SessionSummary[]>       // full pass, incremental via store
    list(): SessionSummary[]                // sorted by lastActivity desc
    getTranscript(id: string): Promise<TranscriptEntry[]>
    watch(): void                           // chokidar on projectsDir/**/*.jsonl
    close(): Promise<void>
  }
  ```

Rules: only files matching `<projectsDir>/<projectDir>/<uuid>.jsonl` (depth exactly 2) count; `subagents/` and other files are ignored. A file is re-parsed only when `mtimeMs` or `size` differ from the cache. `cwdExists` is checked with `fs.access`; `git.inspect` runs only when the cwd exists. `repo` falls back to `basename(cwd)` when git reports null. Stale = `!cwdExists || lastActivity < now - 30 days`. Transcripts with no `sessionId` or no `cwd` are skipped. When `sessionId` is null the file's basename (without `.jsonl`) is used as id.

- [ ] **Step 1: Failing tests**

`packages/engine/test/index/session-index.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionIndex } from '../../src/index/session-index';
import { SessionStore } from '../../src/store/session-store';
import type { GitInfoProvider } from '../../src/git/git-info';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

class FakeGit implements GitInfoProvider {
  calls: string[] = [];
  async inspect(cwd: string) {
    this.calls.push(cwd);
    return { branch: 'feat/live', repo: 'myrepo' };
  }
}

describe('SessionIndex', () => {
  let root: string;
  let projectsDir: string;
  let cwdA: string;
  let git: FakeGit;
  let store: SessionStore;
  let index: SessionIndex | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'relay-index-'));
    projectsDir = join(root, 'projects');
    cwdA = join(root, 'wt-a');
    await mkdir(join(projectsDir, 'proj-a', 'subagents'), { recursive: true });
    await mkdir(cwdA);
    // basic.jsonl points at /repo/wt-a; rewrite cwd so it exists on this machine
    const basic = await readFile(fixture('basic.jsonl'), 'utf8');
    await writeFile(join(projectsDir, 'proj-a', 's-basic.jsonl'), basic.replaceAll('/repo/wt-a', cwdA));
    await copyFile(fixture('no-prompt.jsonl'), join(projectsDir, 'proj-a', 's-noprompt.jsonl'));
    await writeFile(join(projectsDir, 'proj-a', 'subagents', 'agent-1.jsonl'), '{"type":"user"}\n');
    await writeFile(join(projectsDir, 'proj-a', 'notes.txt'), 'ignore me');
    git = new FakeGit();
    store = new SessionStore(':memory:');
  });

  afterEach(async () => {
    await index?.close();
    index = null;
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const make = (now = new Date('2026-09-23T00:00:00.000Z')) =>
    (index = new SessionIndex({ projectsDir, store, git, now: () => now, debounceMs: 20 }));

  it('indexes only session transcripts and ignores stray files', async () => {
    const sessions = await make().scan();
    expect(sessions.map((s) => s.id)).toEqual(['s-noprompt', 's-basic']);
  });

  it('uses live git info for an existing cwd and marks it fresh', async () => {
    const [, basic] = await make().scan();
    expect(basic).toMatchObject({
      id: 's-basic', cwd: cwdA, cwdExists: true, repo: 'myrepo', branch: 'feat/live',
      title: 'Add tests for the zero-rate case', prNumber: 42, isStale: false, messageCount: 4,
    });
    expect(git.calls).toEqual([cwdA]);
  });

  it('marks a missing cwd stale without calling git', async () => {
    const [noPrompt] = await make().scan();
    expect(noPrompt).toMatchObject({
      id: 's-noprompt', cwd: '/repo/wt-c-moved', cwdExists: false, branch: null, repo: 'wt-c-moved', isStale: true,
    });
    expect(git.calls).not.toContain('/repo/wt-c-moved');
  });

  it('marks sessions older than 30 days stale', async () => {
    const [, basic] = await make(new Date('2026-11-01T00:00:00.000Z')).scan();
    expect(basic?.isStale).toBe(true);
  });

  it('re-parses only changed files on a second scan', async () => {
    const idx = make();
    await idx.scan();
    git.calls = [];
    await appendFile(
      join(projectsDir, 'proj-a', 's-basic.jsonl'),
      '\n{"type":"assistant","uuid":"a9","isSidechain":false,"timestamp":"2026-09-22T10:00:00.000Z","cwd":"' + cwdA + '","sessionId":"s-basic","message":{"role":"assistant","content":[{"type":"text","text":"later"}]}}',
    );
    const sessions = await idx.scan();
    expect(sessions.find((s) => s.id === 's-basic')?.messageCount).toBe(5);
    expect(git.calls).toEqual([cwdA]); // no-prompt session was served from cache
  });

  it('returns the transcript entries for a session', async () => {
    const idx = make();
    await idx.scan();
    const entries = await idx.getTranscript('s-basic');
    expect(entries.map((e) => e.uuid)).toEqual(['u1', 'a1', 'u2', 'side1', 'a2']);
  });

  it('emits one changed event after a burst of writes', async () => {
    const idx = make();
    await idx.scan();
    const events: number[] = [];
    idx.on('changed', (s) => events.push(s.length));
    idx.watch();
    await new Promise((r) => setTimeout(r, 100));
    const file = join(projectsDir, 'proj-a', 's-basic.jsonl');
    await appendFile(file, '\n{"type":"mode","mode":"normal","sessionId":"s-basic"}');
    await appendFile(file, '\n{"type":"mode","mode":"normal","sessionId":"s-basic"}');
    await new Promise((r) => setTimeout(r, 400));
    expect(events).toEqual([2]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @relay/engine test session-index`
Expected: FAIL, module not found.

- [ ] **Step 3: Implementation**

`packages/engine/src/index/session-index.ts`:
```ts
import { EventEmitter } from 'node:events';
import { access, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import type { SessionSummary, TranscriptEntry } from '@relay/shared';
import type { GitInfoProvider } from '../git/git-info';
import type { SessionStore } from '../store/session-store';
import { readTranscript } from '../transcript/parse-transcript';

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionIndexOptions {
  projectsDir: string;
  store: SessionStore;
  git: GitInfoProvider;
  now?: () => Date;
  debounceMs?: number;
}

/** Discovers Claude Code sessions on disk, caches their summaries and reports changes. */
export class SessionIndex extends EventEmitter<{ changed: [SessionSummary[]] }> {
  private readonly opts: Required<SessionIndexOptions>;
  private watcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private sessions = new Map<string, SessionSummary>();

  constructor(opts: SessionIndexOptions) {
    super();
    this.opts = { now: () => new Date(), debounceMs: 300, ...opts };
  }

  async scan(): Promise<SessionSummary[]> {
    const files = await this.listTranscriptFiles();
    const summaries: SessionSummary[] = [];
    for (const filePath of files) {
      const summary = await this.summarize(filePath);
      if (summary) summaries.push(summary);
    }
    this.opts.store.removeMissing(files);
    this.sessions = new Map(summaries.map((s) => [s.id, s]));
    return this.list();
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  async getTranscript(id: string): Promise<TranscriptEntry[]> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session ${id}`);
    return (await readTranscript(session.filePath)).entries;
  }

  watch(): void {
    if (this.watcher) return;
    this.watcher = chokidarWatch(this.opts.projectsDir, {
      ignoreInitial: true,
      depth: 1,
      ignored: (path, stats) => !!stats?.isFile() && !path.endsWith('.jsonl'),
    });
    const schedule = () => {
      if (this.rescanTimer) clearTimeout(this.rescanTimer);
      this.rescanTimer = setTimeout(() => {
        this.rescanTimer = null;
        void this.scan().then((s) => this.emit('changed', s));
      }, this.opts.debounceMs);
    };
    this.watcher.on('add', schedule).on('change', schedule).on('unlink', schedule);
  }

  async close(): Promise<void> {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    await this.watcher?.close();
    this.watcher = null;
  }

  /** `<projectsDir>/<project>/<id>.jsonl` only; nested dirs such as `subagents/` are skipped. */
  private async listTranscriptFiles(): Promise<string[]> {
    const files: string[] = [];
    let projects: string[];
    try {
      projects = await readdir(this.opts.projectsDir);
    } catch {
      return files;
    }
    for (const project of projects) {
      const dir = join(this.opts.projectsDir, project);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) files.push(join(dir, e.name));
      }
    }
    return files;
  }

  private async summarize(filePath: string): Promise<SessionSummary | null> {
    const st = await stat(filePath);
    const cached = this.opts.store.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return this.refreshStale(cached.summary);
    }
    const parsed = await readTranscript(filePath);
    if (!parsed.cwd || !parsed.lastActivity) return null;
    const cwdExists = await exists(parsed.cwd);
    const git = cwdExists ? await this.opts.git.inspect(parsed.cwd) : { branch: null, repo: null };
    const summary: SessionSummary = {
      id: parsed.sessionId ?? basename(filePath, '.jsonl'),
      filePath,
      cwd: parsed.cwd,
      cwdExists,
      repo: git.repo ?? basename(parsed.cwd),
      branch: cwdExists ? (git.branch ?? parsed.gitBranch) : null,
      title: parsed.title,
      lastActivity: parsed.lastActivity,
      messageCount: parsed.messageCount,
      prNumber: parsed.prNumber,
      prUrl: parsed.prUrl,
      continuedIn: parsed.continuedIn,
      isStale: false,
    };
    const fresh = this.refreshStale(summary);
    this.opts.store.upsert({ summary: fresh, mtimeMs: st.mtimeMs, size: st.size });
    return fresh;
  }

  private refreshStale(summary: SessionSummary): SessionSummary {
    const tooOld = this.opts.now().getTime() - Date.parse(summary.lastActivity) > STALE_AFTER_MS;
    return { ...summary, isStale: !summary.cwdExists || tooOld };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
```

Live git wins over the transcript's recorded `gitBranch` (the fake returns `feat/live`); a missing cwd yields `branch: null` because a recorded branch for a deleted worktree is noise.

Add to `packages/engine/src/index.ts`:
```ts
export { SessionIndex } from './index/session-index';
export type { SessionIndexOptions } from './index/session-index';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @relay/engine test session-index`
Expected: PASS. If the watch test is flaky on macOS, raise the wait after `watch()` to 300 ms (chokidar needs a moment to arm FSEvents).

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): SessionIndex with incremental scan and file watching"
```

---

### Task 7: RelayEngine facade

**Files:**
- Create: `packages/engine/src/relay-engine.ts`
- Create: `packages/engine/test/relay-engine.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  interface RelayEngineOptions { projectsDir: string; dbPath: string; git?: GitInfoProvider }
  class RelayEngine {
    static async start(opts: RelayEngineOptions): Promise<RelayEngine>   // scans, then watches
    listSessions(): SessionSummary[]
    getTranscript(id: string): Promise<TranscriptEntry[]>
    onSessionsChanged(listener: (s: SessionSummary[]) => void): () => void
    close(): Promise<void>
  }
  ```
  This is the only surface the desktop app imports.

- [ ] **Step 1: Failing test**

`packages/engine/test/relay-engine.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RelayEngine } from '../src/relay-engine';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('RelayEngine', () => {
  let root: string;
  let engine: RelayEngine | null = null;
  afterEach(async () => {
    await engine?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('starts with an initial scan and serves transcripts', async () => {
    root = await mkdtemp(join(tmpdir(), 'relay-engine-'));
    await mkdir(join(root, 'projects', 'p'), { recursive: true });
    await copyFile(fixture('no-prompt.jsonl'), join(root, 'projects', 'p', 's-noprompt.jsonl'));
    engine = await RelayEngine.start({
      projectsDir: join(root, 'projects'),
      dbPath: join(root, 'relay.db'),
      git: { inspect: async () => ({ branch: null, repo: null }) },
    });
    expect(engine.listSessions().map((s) => s.id)).toEqual(['s-noprompt']);
    expect(await engine.getTranscript('s-noprompt')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @relay/engine test relay-engine`
Expected: FAIL, module not found.

- [ ] **Step 3: Implementation**

`packages/engine/src/relay-engine.ts`:
```ts
import type { SessionSummary, TranscriptEntry } from '@relay/shared';
import { ExecGitInfoProvider, type GitInfoProvider } from './git/git-info';
import { SessionIndex } from './index/session-index';
import { SessionStore } from './store/session-store';

export interface RelayEngineOptions {
  projectsDir: string;
  dbPath: string;
  git?: GitInfoProvider;
}

/** The single entry point the desktop app (and later a daemon) talks to. */
export class RelayEngine {
  private constructor(
    private readonly store: SessionStore,
    private readonly index: SessionIndex,
  ) {}

  static async start(opts: RelayEngineOptions): Promise<RelayEngine> {
    const store = new SessionStore(opts.dbPath);
    const index = new SessionIndex({ projectsDir: opts.projectsDir, store, git: opts.git ?? new ExecGitInfoProvider() });
    await index.scan();
    index.watch();
    return new RelayEngine(store, index);
  }

  listSessions(): SessionSummary[] {
    return this.index.list();
  }

  getTranscript(id: string): Promise<TranscriptEntry[]> {
    return this.index.getTranscript(id);
  }

  onSessionsChanged(listener: (sessions: SessionSummary[]) => void): () => void {
    this.index.on('changed', listener);
    return () => this.index.off('changed', listener);
  }

  async close(): Promise<void> {
    await this.index.close();
    this.store.close();
  }
}
```

Add to `packages/engine/src/index.ts`:
```ts
export { RelayEngine } from './relay-engine';
export type { RelayEngineOptions } from './relay-engine';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @relay/engine test`
Expected: all engine tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): RelayEngine facade over index and store"
```

---

### Task 8: Electron shell with IPC bridge

**Files:**
- Create: `apps/desktop/` via the Forge template, then edit `package.json`, `forge.config.ts`, `vite.main.config.ts`, `vite.renderer.config.ts`, `tsconfig.json`, `src/main.ts`, `src/preload.ts`, `src/ipc.ts`, `src/renderer.tsx`, `index.html`
- Create: `packages/shared/src/ipc.ts`, modify `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `RelayEngine`.
- Produces: `window.relay: RelayApi` in the renderer:
  ```ts
  interface RelayApi {
    listSessions(): Promise<SessionSummary[]>;
    getTranscript(id: string): Promise<TranscriptEntry[]>;
    onSessionsChanged(listener: (s: SessionSummary[]) => void): () => void;
  }
  ```

- [ ] **Step 1: Scaffold with Forge**

Run from the repo root:
```bash
pnpm create electron-app@latest apps/desktop -- --template=vite-typescript
```
Then in `apps/desktop/package.json` set `"name": "@relay/desktop"`, `"private": true`, and add dependencies:
```bash
pnpm --filter @relay/desktop add react react-dom @relay/engine@workspace:* @relay/shared@workspace:*
pnpm --filter @relay/desktop add -D @types/react @types/react-dom @vitejs/plugin-react
```
Delete the template's `src/index.css` content later (Task 9 restyles); keep `src/index.ts` renamed to `src/main.ts` and update `"main"` in `package.json` and the `entry` in `forge.config.ts` accordingly.

- [ ] **Step 2: Shared IPC contract**

`packages/shared/src/ipc.ts`:
```ts
import type { SessionSummary } from './session';
import type { TranscriptEntry } from './transcript';

export const IPC = {
  listSessions: 'relay:listSessions',
  getTranscript: 'relay:getTranscript',
  sessionsChanged: 'relay:sessionsChanged',
} as const;

/** What the renderer sees on `window.relay`. */
export interface RelayApi {
  listSessions(): Promise<SessionSummary[]>;
  getTranscript(id: string): Promise<TranscriptEntry[]>;
  onSessionsChanged(listener: (sessions: SessionSummary[]) => void): () => void;
}
```
Add to `packages/shared/src/index.ts`: `export { IPC } from './ipc'; export type { RelayApi } from './ipc';`

- [ ] **Step 3: Main process**

`apps/desktop/src/ipc.ts`:
```ts
import { BrowserWindow, ipcMain } from 'electron';
import type { RelayEngine } from '@relay/engine';
import { IPC } from '@relay/shared';

/** Wires one engine to IPC; returns a disposer. */
export function registerEngineIpc(engine: RelayEngine): () => void {
  ipcMain.handle(IPC.listSessions, () => engine.listSessions());
  ipcMain.handle(IPC.getTranscript, (_e, id: string) => engine.getTranscript(id));
  const unsubscribe = engine.onSessionsChanged((sessions) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.sessionsChanged, sessions);
  });
  return () => {
    unsubscribe();
    ipcMain.removeHandler(IPC.listSessions);
    ipcMain.removeHandler(IPC.getTranscript);
  };
}
```

`apps/desktop/src/main.ts` (replace the template body):
```ts
import { app, BrowserWindow } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RelayEngine } from '@relay/engine';
import { registerEngineIpc } from './ipc';

// MAIN_WINDOW_VITE_DEV_SERVER_URL and MAIN_WINDOW_VITE_NAME are declared by the template's forge.env.d.ts.

let engine: RelayEngine | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: join(__dirname, 'preload.js') },
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

app.whenReady().then(async () => {
  engine = await RelayEngine.start({
    projectsDir: process.env.RELAY_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects'),
    dbPath: join(app.getPath('userData'), 'relay.db'),
  });
  registerEngineIpc(engine);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void engine?.close();
});
```
(`RELAY_PROJECTS_DIR` lets the smoke test point at fixtures.)

`apps/desktop/src/preload.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type RelayApi, type SessionSummary } from '@relay/shared';

const api: RelayApi = {
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  getTranscript: (id) => ipcRenderer.invoke(IPC.getTranscript, id),
  onSessionsChanged: (listener) => {
    const handler = (_e: unknown, sessions: SessionSummary[]) => listener(sessions);
    ipcRenderer.on(IPC.sessionsChanged, handler);
    return () => ipcRenderer.off(IPC.sessionsChanged, handler);
  },
};

contextBridge.exposeInMainWorld('relay', api);
```

`apps/desktop/src/global.d.ts`:
```ts
import type { RelayApi } from '@relay/shared';

declare global {
  interface Window { relay: RelayApi }
}
```

- [ ] **Step 4: Vite config**

`apps/desktop/vite.main.config.ts`:
```ts
import { defineConfig } from 'vite';

export default defineConfig({
  build: { rollupOptions: { external: ['node:sqlite', 'chokidar'] } },
});
```
(`node:sqlite` is not in every Vite builtin list; `chokidar` stays external because it loads optional native fsevents at runtime. Forge copies `dependencies` into the packaged app.)

`apps/desktop/vite.renderer.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()] });
```

`apps/desktop/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["DOM", "DOM.Iterable", "ES2023"], "types": ["node"] },
  "include": ["src", "*.config.ts", "forge.config.ts"]
}
```

- [ ] **Step 5: Minimal renderer**

`apps/desktop/index.html` — change the script tag to `<script type="module" src="/src/renderer.tsx"></script>` and add `<div id="root"></div>`.

`apps/desktop/src/renderer.tsx`:
```tsx
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { SessionSummary } from '@relay/shared';

function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  useEffect(() => {
    void window.relay.listSessions().then(setSessions);
    return window.relay.onSessionsChanged(setSessions);
  }, []);
  return <pre data-testid="session-count">{sessions.length} sessions</pre>;
}

createRoot(document.getElementById('root')!).render(<App />);
```

- [ ] **Step 6: Run it**

Run: `pnpm --filter @relay/desktop start`
Expected: a window showing "N sessions" where N matches `ls ~/.claude/projects/*/*.jsonl | wc -l` minus transcripts with no cwd. Fix any bundling error before moving on (typical: missing `external`, wrong preload path).

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(desktop): Electron shell exposing RelayEngine over IPC"
```

---

### Task 9: Session list UI

**Files:**
- Create: `apps/desktop/src/ui/App.tsx`, `apps/desktop/src/ui/SessionList.tsx`, `apps/desktop/src/ui/groupSessions.ts`, `apps/desktop/src/ui/styles.css`
- Create: `apps/desktop/src/ui/groupSessions.test.ts`, `apps/desktop/src/ui/SessionList.test.tsx`, `apps/desktop/vitest.config.ts`
- Modify: `apps/desktop/src/renderer.tsx`, `apps/desktop/package.json`

**Interfaces:**
- Consumes: `SessionSummary`.
- Produces:
  ```ts
  function groupSessions(sessions: SessionSummary[], opts: { query: string; showStale: boolean }): { repo: string; sessions: SessionSummary[] }[]
  <SessionList sessions selectedId onSelect />
  ```

- [ ] **Step 1: Test setup**

```bash
pnpm --filter @relay/desktop add -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```
Add `"test": "vitest run"` to `apps/desktop/package.json` scripts.

`apps/desktop/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'], setupFiles: ['./src/test-setup.ts'] },
});
```
`apps/desktop/src/test-setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 2: Failing tests**

`apps/desktop/src/ui/groupSessions.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@relay/shared';
import { groupSessions } from './groupSessions';

const s = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'x', filePath: '/f', cwd: '/c', cwdExists: true, repo: 'repo', branch: 'main', title: 'T',
  lastActivity: '2026-09-20T00:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null, continuedIn: null,
  isStale: false, ...over,
});

describe('groupSessions', () => {
  it('groups by repo, ordering groups by their newest session', () => {
    const groups = groupSessions(
      [
        s({ id: 'a', repo: 'old', lastActivity: '2026-09-01T00:00:00.000Z' }),
        s({ id: 'b', repo: 'new', lastActivity: '2026-09-20T00:00:00.000Z' }),
        s({ id: 'c', repo: 'old', lastActivity: '2026-09-10T00:00:00.000Z' }),
      ],
      { query: '', showStale: true },
    );
    expect(groups.map((g) => g.repo)).toEqual(['new', 'old']);
    expect(groups[1]?.sessions.map((x) => x.id)).toEqual(['c', 'a']);
  });

  it('hides stale sessions unless asked', () => {
    const list = [s({ id: 'fresh' }), s({ id: 'stale', isStale: true })];
    expect(groupSessions(list, { query: '', showStale: false })[0]?.sessions.map((x) => x.id)).toEqual(['fresh']);
    expect(groupSessions(list, { query: '', showStale: true })[0]?.sessions).toHaveLength(2);
  });

  it('filters by title, branch and repo, case-insensitively', () => {
    const list = [s({ id: 'a', title: 'Mileage claims' }), s({ id: 'b', branch: 'feat/ocr' }), s({ id: 'c', repo: 'Other' })];
    expect(groupSessions(list, { query: 'MILEAGE', showStale: true }).flatMap((g) => g.sessions.map((x) => x.id))).toEqual(['a']);
    expect(groupSessions(list, { query: 'ocr', showStale: true }).flatMap((g) => g.sessions.map((x) => x.id))).toEqual(['b']);
    expect(groupSessions(list, { query: 'other', showStale: true }).flatMap((g) => g.sessions.map((x) => x.id))).toEqual(['c']);
  });
});
```

`apps/desktop/src/ui/SessionList.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionSummary } from '@relay/shared';
import { SessionList } from './SessionList';

const s = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'x', filePath: '/f', cwd: '/c', cwdExists: true, repo: 'repo', branch: 'main', title: 'T',
  lastActivity: '2026-09-20T00:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null, continuedIn: null,
  isStale: false, ...over,
});

describe('SessionList', () => {
  it('renders repo headers, rows with branch and PR badge, and selects on click', async () => {
    const onSelect = vi.fn();
    render(
      <SessionList
        sessions={[s({ id: 'a', title: 'Mileage', branch: 'feat/mileage', prNumber: 115760 }), s({ id: 'b', title: 'Stale one', isStale: true })]}
        selectedId={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole('heading', { name: 'repo' })).toBeInTheDocument();
    expect(screen.getByText('feat/mileage')).toBeInTheDocument();
    expect(screen.getByText('#115760')).toBeInTheDocument();
    expect(screen.queryByText('Stale one')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Show stale'));
    expect(screen.getByText('Stale one')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Mileage'));
    expect(onSelect).toHaveBeenCalledWith('a');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @relay/desktop test`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implementation**

`apps/desktop/src/ui/groupSessions.ts`:
```ts
import type { SessionSummary } from '@relay/shared';

export interface SessionGroup {
  repo: string;
  sessions: SessionSummary[];
}

/** Filters and groups sessions for the sidebar; groups and rows are newest-first. */
export function groupSessions(
  sessions: SessionSummary[],
  opts: { query: string; showStale: boolean },
): SessionGroup[] {
  const q = opts.query.trim().toLowerCase();
  const visible = sessions.filter(
    (s) =>
      (opts.showStale || !s.isStale) &&
      (q === '' || [s.title, s.branch ?? '', s.repo].some((f) => f.toLowerCase().includes(q))),
  );
  const byRepo = new Map<string, SessionSummary[]>();
  for (const s of visible) byRepo.set(s.repo, [...(byRepo.get(s.repo) ?? []), s]);
  const newest = (list: SessionSummary[]) => list[0]?.lastActivity ?? '';
  return [...byRepo.entries()]
    .map(([repo, list]) => ({ repo, sessions: list.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)) }))
    .sort((a, b) => newest(b.sessions).localeCompare(newest(a.sessions)));
}
```

`apps/desktop/src/ui/SessionList.tsx`:
```tsx
import { useState } from 'react';
import type { SessionSummary } from '@relay/shared';
import { groupSessions } from './groupSessions';

interface Props {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function SessionList({ sessions, selectedId, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [showStale, setShowStale] = useState(false);
  const groups = groupSessions(sessions, { query, showStale });
  return (
    <aside className="session-list">
      <div className="session-list__controls">
        <input type="search" placeholder="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label>
          <input type="checkbox" aria-label="Show stale" checked={showStale} onChange={(e) => setShowStale(e.target.checked)} />
          Stale
        </label>
      </div>
      {groups.map((g) => (
        <section key={g.repo}>
          <h2>{g.repo}</h2>
          <ul>
            {g.sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={s.id === selectedId ? 'session-row session-row--selected' : 'session-row'}
                  onClick={() => onSelect(s.id)}
                >
                  <span className="session-row__title">{s.title}</span>
                  <span className="session-row__meta">
                    {s.branch && <code>{s.branch}</code>}
                    {s.prNumber !== null && <span className="badge">#{s.prNumber}</span>}
                    <time dateTime={s.lastActivity}>{new Date(s.lastActivity).toLocaleDateString()}</time>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
```

`apps/desktop/src/ui/App.tsx`:
```tsx
import { useEffect, useState } from 'react';
import type { SessionSummary } from '@relay/shared';
import { SessionList } from './SessionList';

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    void window.relay.listSessions().then(setSessions);
    return window.relay.onSessionsChanged(setSessions);
  }, []);
  return (
    <div className="app">
      <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />
      <main className="orchestrator" aria-label="Orchestrator">
        <p className="placeholder">Orchestrator chat arrives in milestone 3.</p>
      </main>
      <section className="session-panel" aria-label="Session panel" data-session-id={selectedId ?? ''} />
    </div>
  );
}
```

`apps/desktop/src/ui/styles.css`:
```css
:root { color-scheme: light dark; font: 13px/1.4 -apple-system, system-ui, sans-serif; }
body { margin: 0; }
.app { display: grid; grid-template-columns: 300px 1fr 420px; height: 100vh; }
.session-list { border-right: 1px solid color-mix(in srgb, currentColor 15%, transparent); overflow: auto; padding: 40px 8px 8px; }
.session-list__controls { display: flex; gap: 8px; margin-bottom: 8px; }
.session-list__controls input[type="search"] { flex: 1; }
.session-list h2 { font-size: 11px; text-transform: uppercase; opacity: .6; margin: 12px 8px 4px; }
.session-list ul { list-style: none; margin: 0; padding: 0; }
.session-row { display: block; width: 100%; text-align: left; background: none; border: 0; border-radius: 6px; padding: 6px 8px; color: inherit; cursor: pointer; }
.session-row:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.session-row--selected { background: color-mix(in srgb, currentColor 14%, transparent); }
.session-row__title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-row__meta { display: flex; gap: 6px; font-size: 11px; opacity: .7; }
.badge { border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
.orchestrator, .session-panel { overflow: auto; padding: 40px 16px 16px; }
.session-panel { border-left: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
.placeholder { opacity: .5; }
```

`apps/desktop/src/renderer.tsx`:
```tsx
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';

createRoot(document.getElementById('root')!).render(<App />);
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @relay/desktop test && pnpm --filter @relay/desktop start`
Expected: tests PASS; the app shows your repos as groups (e.g. `factorial-agent`, `factorial`) with worktree sessions under their main repo.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): grouped, searchable session list"
```

---

### Task 10: Read-only transcript viewer

**Files:**
- Create: `apps/desktop/src/ui/TranscriptView.tsx`, `apps/desktop/src/ui/TranscriptView.test.tsx`
- Modify: `apps/desktop/src/ui/App.tsx`, `apps/desktop/src/ui/styles.css`

**Interfaces:**
- Consumes: `TranscriptEntry`, `window.relay.getTranscript`.
- Produces: `<TranscriptView entries hideSidechain />`.

Rendering rules: `text` blocks as paragraphs (plain text, `white-space: pre-wrap`; no markdown library yet); `thinking` omitted; `tool_use` as a one-line chip `▸ Read {"file_path":...}` with the JSON input truncated to 120 chars; `tool_result` collapsed inside `<details>` with the first line as summary; `image` as `[image]`; `isMeta` entries hidden; sidechain entries hidden when `hideSidechain`.

- [ ] **Step 1: Failing test**

`apps/desktop/src/ui/TranscriptView.test.tsx`:
```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TranscriptEntry } from '@relay/shared';
import { TranscriptView } from './TranscriptView';

const entries: TranscriptEntry[] = [
  { uuid: 'u1', role: 'user', timestamp: '2026-09-20T10:00:00.000Z', isSidechain: false, isMeta: false, blocks: [{ kind: 'text', text: 'add tests' }] },
  { uuid: 'a1', role: 'assistant', timestamp: '2026-09-20T10:00:05.000Z', isSidechain: false, isMeta: false, blocks: [
    { kind: 'thinking' },
    { kind: 'text', text: 'Looking.' },
    { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } },
  ] },
  { uuid: 'u2', role: 'user', timestamp: '2026-09-20T10:00:06.000Z', isSidechain: false, isMeta: false, blocks: [
    { kind: 'tool_result', toolUseId: 't1', text: 'line one\nline two', isError: false },
  ] },
  { uuid: 'm1', role: 'user', timestamp: '2026-09-20T10:00:07.000Z', isSidechain: false, isMeta: true, blocks: [{ kind: 'text', text: 'META' }] },
  { uuid: 's1', role: 'user', timestamp: '2026-09-20T10:00:08.000Z', isSidechain: true, isMeta: false, blocks: [{ kind: 'text', text: 'SIDE' }] },
];

describe('TranscriptView', () => {
  it('renders text, tool chips and collapsed results; hides meta and sidechain', () => {
    render(<TranscriptView entries={entries} hideSidechain />);
    expect(screen.getByText('add tests')).toBeInTheDocument();
    expect(screen.getByText('Looking.')).toBeInTheDocument();
    expect(screen.getByText(/Read \{"file_path":"\/a\.ts"\}/)).toBeInTheDocument();
    expect(screen.getByText('line one')).toBeInTheDocument();
    expect(screen.queryByText('META')).not.toBeInTheDocument();
    expect(screen.queryByText('SIDE')).not.toBeInTheDocument();
  });

  it('shows sidechain entries when asked', () => {
    render(<TranscriptView entries={entries} hideSidechain={false} />);
    expect(screen.getByText('SIDE')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @relay/desktop test TranscriptView`
Expected: FAIL, module not found.

- [ ] **Step 3: Implementation**

`apps/desktop/src/ui/TranscriptView.tsx`:
```tsx
import type { TranscriptBlock, TranscriptEntry } from '@relay/shared';

interface Props {
  entries: TranscriptEntry[];
  hideSidechain: boolean;
}

const INPUT_MAX = 120;

function Block({ block }: { block: TranscriptBlock }) {
  switch (block.kind) {
    case 'text':
      return <p className="block-text">{block.text}</p>;
    case 'tool_use': {
      const input = JSON.stringify(block.input) ?? '';
      return (
        <div className="block-tool">
          ▸ {block.name} {input.length > INPUT_MAX ? `${input.slice(0, INPUT_MAX)}…` : input}
        </div>
      );
    }
    case 'tool_result': {
      const [first = '', ...rest] = block.text.split('\n');
      return (
        <details className={block.isError ? 'block-result block-result--error' : 'block-result'}>
          <summary>{first}</summary>
          {rest.length > 0 && <pre>{rest.join('\n')}</pre>}
        </details>
      );
    }
    case 'image':
      return <p className="block-text">[image]</p>;
    case 'thinking':
      return null;
  }
}

export function TranscriptView({ entries, hideSidechain }: Props) {
  const visible = entries.filter((e) => !e.isMeta && (!hideSidechain || !e.isSidechain));
  return (
    <ol className="transcript">
      {visible.map((e) => (
        <li key={e.uuid} className={`entry entry--${e.role}${e.isSidechain ? ' entry--sidechain' : ''}`}>
          <header>
            <span>{e.role}</span>
            <time dateTime={e.timestamp}>{new Date(e.timestamp).toLocaleTimeString()}</time>
          </header>
          {e.blocks.map((b, i) => <Block key={i} block={b} />)}
        </li>
      ))}
    </ol>
  );
}
```

Update `apps/desktop/src/ui/App.tsx` so the right column loads the transcript:
```tsx
import { useEffect, useState } from 'react';
import type { SessionSummary, TranscriptEntry } from '@relay/shared';
import { SessionList } from './SessionList';
import { TranscriptView } from './TranscriptView';

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [showSidechain, setShowSidechain] = useState(false);
  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  useEffect(() => {
    void window.relay.listSessions().then(setSessions);
    return window.relay.onSessionsChanged(setSessions);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void window.relay.getTranscript(selectedId).then((t) => { if (!cancelled) setEntries(t); });
    return () => { cancelled = true; };
  }, [selectedId, sessions]);

  return (
    <div className="app">
      <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />
      <main className="orchestrator" aria-label="Orchestrator">
        <p className="placeholder">Orchestrator chat arrives in milestone 3.</p>
      </main>
      <section className="session-panel" aria-label="Session panel">
        {selected ? (
          <>
            <header className="session-panel__header">
              <h1>{selected.title}</h1>
              <p>
                <code>{selected.cwd}</code> {selected.branch && <code>{selected.branch}</code>}{' '}
                {selected.prUrl && <a href={selected.prUrl} target="_blank" rel="noreferrer">PR #{selected.prNumber}</a>}
              </p>
              <label>
                <input type="checkbox" checked={showSidechain} onChange={(e) => setShowSidechain(e.target.checked)} /> Show subagent turns
              </label>
            </header>
            <TranscriptView entries={entries} hideSidechain={!showSidechain} />
          </>
        ) : (
          <p className="placeholder">Select a session.</p>
        )}
      </section>
    </div>
  );
}
```
(`sessions` in the transcript effect's deps re-fetches when the watcher reports a change, so a live session's panel updates.)

Append to `styles.css`:
```css
.transcript { list-style: none; margin: 0; padding: 0; }
.entry { margin: 0 0 12px; padding: 8px 10px; border-radius: 8px; }
.entry--user { background: color-mix(in srgb, currentColor 6%, transparent); }
.entry--sidechain { opacity: .6; }
.entry header { display: flex; justify-content: space-between; font-size: 11px; opacity: .6; margin-bottom: 4px; }
.block-text { white-space: pre-wrap; margin: 0 0 6px; }
.block-tool { font-family: ui-monospace, monospace; font-size: 12px; opacity: .8; }
.block-result summary { font-family: ui-monospace, monospace; font-size: 12px; cursor: pointer; }
.block-result pre { font-size: 12px; max-height: 240px; overflow: auto; }
.block-result--error summary { color: #c0392b; }
.session-panel__header h1 { font-size: 15px; margin: 0 0 4px; }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @relay/desktop test && pnpm typecheck && pnpm --filter @relay/desktop start`
Expected: tests PASS; clicking a session shows its transcript; tool results are collapsed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): read-only transcript viewer"
```

---

### Task 11: Electron smoke test

**Files:**
- Create: `apps/desktop/e2e/smoke.spec.ts`, `apps/desktop/playwright.config.ts`
- Modify: `apps/desktop/package.json`, `.gitignore`

**Interfaces:**
- Consumes: `RELAY_PROJECTS_DIR` from Task 8; the engine fixtures.

- [ ] **Step 1: Setup**

```bash
pnpm --filter @relay/desktop add -D @playwright/test
```
Add `"test:e2e": "pnpm package && playwright test"` to `apps/desktop/package.json` scripts (Forge's `package` produces `out/…/Relay Hub.app`; the test launches the built main bundle).

`apps/desktop/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: './e2e', timeout: 60_000 });
```

- [ ] **Step 2: The test**

`apps/desktop/e2e/smoke.spec.ts`:
```ts
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('lists sessions from a fixtures dir and opens a transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-e2e-'));
  await mkdir(join(root, 'projects', 'p'), { recursive: true });
  const fixtures = resolve(__dirname, '../../../packages/engine/test/fixtures');
  await copyFile(join(fixtures, 'no-prompt.jsonl'), join(root, 'projects', 'p', 's-noprompt.jsonl'));

  const app = await electron.launch({
    args: [resolve(__dirname, '../.vite/build/main.js')],
    env: { ...process.env, RELAY_PROJECTS_DIR: join(root, 'projects') },
  });
  const page = await app.firstWindow();

  await page.getByLabel('Show stale').check(); // fixture cwd does not exist here
  await page.getByText('Untitled session').click();
  await expect(page.getByLabel('Session panel')).toContainText('/repo/wt-c-moved');
  await app.close();
});
```

- [ ] **Step 3: Run**

Run: `pnpm --filter @relay/desktop test:e2e`
Expected: PASS. If `main.js` is not at `.vite/build/main.js`, check `forge.config.ts`'s Vite plugin `build` entries and adjust the path.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(desktop): Electron smoke test over fixture transcripts"
```

---

### Task 12: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write it**

```markdown
# Relay Hub

One place for all your Claude Code sessions. Milestone 1: index and read.

## Run
pnpm install
pnpm dev                 # Electron app
pnpm test                # engine + renderer unit tests
pnpm --filter @relay/desktop test:e2e

## Layout
apps/desktop      Electron (Forge + Vite + React)
packages/engine   session indexing; no Electron imports
packages/shared   types and IPC contract

Design: docs/superpowers/specs/2026-09-23-relay-hub-design.md
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README"
```

---

## Follow-up plans (outline only)

Each gets its own plan document when milestone 1 is done.

**M2 — SessionRunner and approvals.** Add `@anthropic-ai/claude-agent-sdk`. `AgentClient` interface wrapping `query()` with streaming input; `SessionRunner` with states `idle | running | waiting-approval | error`, delivery modes `steer | queue | interrupt`, origin tags; `ApprovalQueue` with the destructive-git and outside-cwd rules; `RelayEngine.send(id, prompt, { mode, origin })` and `RelayEngine.decide(approvalId, decision)`; live transcript streaming to the panel; a dev-only "send" input in the session panel; approvals drawer.

**M3 — Orchestrator.** Persistent SDK session with an in-process MCP server exposing `list_sessions`, `get_session`, `send_to_session`, `interrupt_session`; completion relay injecting turn-end events; orchestrator chat column replacing the placeholder; stored orchestrator thread id.

**M4 — Bulk actions.** `propose_bulk_action`, `BulkRun` with concurrency cap 3, plan card with tickable rows and confirm/cancel, per-row progress, run summary into the orchestrator; run history in the Store.

**M5 — PR watches.** `PrWatcher` polling `gh pr view --json` every 5 min, snapshot diffing to `ci_failed | review_comment | base_moved | merged`, wakes in `queue` mode, `list_prs`, `create_watch`/`delete_watch`, offline banner, native notifications, quit confirmation with running sessions.
