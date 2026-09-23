import { isAbsolute, relative } from 'node:path';
import type { ApprovalReason } from '@relay/shared';

export type Verdict = { outcome: 'allow' } | { outcome: 'ask'; reason: ApprovalReason; summary: string };

const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit']);
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];
const SAFE_ROOTS = ['/tmp', '/private/tmp'];

/** Splits a shell line into commands, each as its tokens; chained steps are inspected one by one. */
function segments(command: string): string[][] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((t) => t.length > 0);
}

function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function outsideCwd(path: string, cwd: string): boolean {
  return isAbsolute(path) && !isUnder(path, cwd) && !SAFE_ROOTS.some((r) => isUnder(path, r));
}

/** A flag cluster such as `-rf`, `-fr` or `-Rf`: both recursive and force. */
function isRecursiveForce(flag: string): boolean {
  if (!flag.startsWith('-') || flag.startsWith('--')) return false;
  const letters = flag.slice(1).toLowerCase();
  return letters.includes('r') && letters.includes('f');
}

function destructive(tokens: string[]): boolean {
  const [cmd, sub, ...rest] = tokens;
  if (cmd === 'rm') return tokens.slice(1).some(isRecursiveForce);
  if (cmd !== 'git') return false;
  switch (sub) {
    case 'push':
      return rest.some(
        (t) => t === '--force' || t === '-f' || t.startsWith('--force-with-lease') || t.startsWith('+'),
      );
    case 'reset':
      return rest.includes('--hard');
    case 'clean':
    case 'filter-branch':
    case 'filter-repo':
      return true;
    case 'branch':
      return rest.includes('-D');
    case 'rebase':
      return !rest.some((t) => t === '--continue' || t === '--abort' || t === '--skip');
    case 'commit':
      return rest.includes('--amend');
    default:
      return false;
  }
}

/** Decides whether a tool call may run under accept-edits or must wait for the user. */
export function classifyToolUse(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  blockedPath?: string,
): Verdict {
  if (blockedPath) return { outcome: 'ask', reason: 'blocked-path', summary: blockedPath };

  if (toolName === 'Bash' && typeof input.command === 'string') {
    const command = input.command;
    const segs = segments(command);
    if (segs.some(destructive)) return { outcome: 'ask', reason: 'destructive-git', summary: command };
    if (segs.flat().some((t) => outsideCwd(t, cwd))) return { outcome: 'ask', reason: 'outside-cwd', summary: command };
    return { outcome: 'allow' };
  }

  if (FILE_TOOLS.has(toolName)) {
    for (const key of PATH_KEYS) {
      const p = input[key];
      if (typeof p === 'string' && outsideCwd(p, cwd)) return { outcome: 'ask', reason: 'outside-cwd', summary: p };
    }
  }
  return { outcome: 'allow' };
}

/** Key for "allow this kind again": tool plus the first two words of a shell command. */
export function patternKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    const head = input.command.trim().split(/\s+/).slice(0, 2).join(' ');
    return `${toolName} ${head}`;
  }
  return toolName;
}
