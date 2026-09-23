import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ApprovalReason } from '@relay/shared';
import { repoRootOf } from './repo-root';

export type Verdict =
  | { outcome: 'allow' }
  | {
      outcome: 'ask';
      reason: ApprovalReason;
      summary: string;
      /** Names the offending step or directory, so "allow this kind" covers exactly that. */
      patternKey: string;
    };

const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit']);
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];
/** Absolute roots a command may touch without asking. */
const SAFE_ROOTS = ['/tmp', '/private/tmp', '/dev', '/usr', '/bin', '/sbin', '/opt/homebrew'];
/** Programs that only run the command that follows them. */
const WRAPPERS = new Set(['sudo', 'command', 'env', 'nohup', 'time', 'xargs', 'exec', 'nice', 'doas']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** Splits on shell separators outside quotes; each piece is one command. */
function splitCommands(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Whitespace tokens with surrounding quotes removed; a quoted string stays one token. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let had = false;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      had = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      had = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (had) tokens.push(cur);
      cur = '';
      had = false;
      continue;
    }
    cur += ch;
    had = true;
  }
  if (had) tokens.push(cur);
  return tokens;
}

/** Pulls `$(...)` and backtick bodies out of a line, returning them plus the line with them blanked. */
function extractSubshells(line: string): { outer: string; inner: string[] } {
  const inner: string[] = [];
  let outer = '';
  let i = 0;
  while (i < line.length) {
    if (line.startsWith('$(', i)) {
      let depth = 1;
      let j = i + 2;
      while (j < line.length && depth > 0) {
        if (line.startsWith('$(', j)) depth += 1;
        else if (line[j] === ')') depth -= 1;
        j += 1;
      }
      inner.push(line.slice(i + 2, j - 1));
      outer += ' ';
      i = j;
      continue;
    }
    if (line[i] === '`') {
      const j = line.indexOf('`', i + 1);
      const end = j === -1 ? line.length : j;
      inner.push(line.slice(i + 1, end));
      outer += ' ';
      i = end + 1;
      continue;
    }
    outer += line[i];
    i += 1;
  }
  return { outer, inner };
}

/** Every command in the line, including those nested in subshells and `sh -c` strings, as tokens. */
function commands(line: string, depth = 0): string[][] {
  if (depth > 4) return [];
  const { outer, inner } = extractSubshells(line);
  const result: string[][] = inner.flatMap((s) => commands(s, depth + 1));
  for (const raw of splitCommands(outer)) {
    const segment = raw.replace(/^\(+/, '').replace(/\)+$/, '');
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    result.push(tokens);
    const shellIdx = tokens.findIndex((t) => SHELLS.has(basename(t).toLowerCase()));
    const c = tokens.indexOf('-c', shellIdx);
    if (shellIdx !== -1 && c !== -1 && tokens[c + 1]) result.push(...commands(tokens[c + 1]!, depth + 1));
  }
  return result;
}

/** Drops env assignments and wrappers so the real program is first; lowercases its name. */
function normalize(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || WRAPPERS.has(basename(tokens[i]!).toLowerCase()))) {
    i += 1;
  }
  const rest = tokens.slice(i);
  if (rest.length === 0) return [];
  return [basename(rest[0]!).toLowerCase(), ...rest.slice(1)];
}

/** Skips git's global options (`-c k=v`, `-C dir`, `--git-dir=…`) so the subcommand comes first. */
function gitSubcommand(tokens: string[]): { sub: string | undefined; rest: string[] } {
  let i = 1;
  while (i < tokens.length && tokens[i]!.startsWith('-')) {
    i += tokens[i] === '-c' || tokens[i] === '-C' ? 2 : 1;
  }
  return { sub: tokens[i]?.toLowerCase(), rest: tokens.slice(i + 1) };
}

function rmIsRecursiveForce(flags: string[]): boolean {
  let recursive = false;
  let force = false;
  for (const f of flags) {
    if (f === '--recursive') recursive = true;
    else if (f === '--force') force = true;
    else if (f.startsWith('-') && !f.startsWith('--')) {
      const letters = f.slice(1).toLowerCase();
      if (letters.includes('r')) recursive = true;
      if (letters.includes('f')) force = true;
    }
  }
  return recursive && force;
}

/** Returns the pattern key of a destructive command, or null. */
function destructiveKey(tokens: string[]): string | null {
  const [cmd] = tokens;
  if (cmd === 'rm') return rmIsRecursiveForce(tokens.slice(1)) ? `rm ${tokens[1] ?? ''}`.trim() : null;
  if (cmd !== 'git') return null;
  const { sub, rest } = gitSubcommand(tokens);
  const key = `git ${sub ?? ''}`.trim();
  switch (sub) {
    case 'push':
      return rest.some(
        (t) =>
          t === '--force' ||
          t === '-f' ||
          t === '-d' ||
          t === '--delete' ||
          t === '--mirror' ||
          t.startsWith('--force-with-lease') ||
          t.startsWith('+') ||
          (t.startsWith(':') && t.length > 1),
      )
        ? key
        : null;
    case 'reset':
      return rest.includes('--hard') ? key : null;
    case 'clean':
    case 'filter-branch':
    case 'filter-repo':
      return key;
    case 'branch':
      return rest.includes('-D') ? key : null;
    case 'rebase':
      return rest.some((t) => t === '--continue' || t === '--abort' || t === '--skip') ? null : key;
    case 'commit':
      return rest.includes('--amend') ? key : null;
    default:
      return null;
  }
}

function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Resolves a token that looks like a path to an absolute one, or null when it is not a path. */
function pathOf(token: string, cwd: string): string | null {
  let t = token;
  const eq = t.indexOf('=');
  if (t.startsWith('-') && eq !== -1) t = t.slice(eq + 1);
  if (t === '~' || t.startsWith('~/')) t = homedir() + t.slice(1);
  if (t.startsWith('$HOME')) t = homedir() + t.slice(5);
  if (isAbsolute(t)) return t;
  if (t.split('/').includes('..')) return resolve(cwd, t);
  return null;
}

function outsideCwd(path: string, cwd: string): boolean {
  return !isUnder(path, cwd) && !SAFE_ROOTS.some((r) => isUnder(path, r));
}

/** Decides whether a tool call may run under accept-edits or must wait for the user. */
export function classifyToolUse(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  blockedPath?: string,
  repoRoot: (path: string) => string | null = repoRootOf,
): Verdict {
  if (blockedPath) {
    return { outcome: 'ask', reason: 'blocked-path', summary: blockedPath, patternKey: `${toolName} blocked ${dirname(blockedPath)}` };
  }

  if (toolName === 'Bash' && typeof input.command === 'string') {
    const command = input.command;
    const all = commands(command);
    for (const tokens of all) {
      const key = destructiveKey(normalize(tokens));
      if (key) return { outcome: 'ask', reason: 'destructive-git', summary: command, patternKey: `Bash ${key}` };
    }
    for (const tokens of all) {
      for (const token of tokens) {
        const p = pathOf(token, cwd);
        if (p && outsideCwd(p, cwd)) {
          return { outcome: 'ask', reason: 'outside-cwd', summary: command, patternKey: `Bash path ${repoRoot(p) ?? dirname(p)}` };
        }
      }
    }
    return { outcome: 'allow' };
  }

  if (FILE_TOOLS.has(toolName)) {
    for (const key of PATH_KEYS) {
      const raw = input[key];
      if (typeof raw !== 'string') continue;
      const p = resolve(cwd, raw);
      if (outsideCwd(p, cwd)) {
        return { outcome: 'ask', reason: 'outside-cwd', summary: raw, patternKey: `${toolName} ${repoRoot(p) ?? dirname(p)}` };
      }
    }
  }
  return { outcome: 'allow' };
}
