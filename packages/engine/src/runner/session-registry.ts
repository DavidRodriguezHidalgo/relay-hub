import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Who else has a session open right now. */
export interface SessionRegistry {
  /** Pids of live Claude Code processes holding the session that Relay did not start. */
  foreignHolders(sessionId: string): Promise<number[]>;
  /** Every session held by a live Claude process Relay did not start, with that process's status. */
  openSessions?(): Promise<Record<string, 'busy' | 'idle'>>;
}

export interface ClaudeSessionRegistryOptions {
  /** Claude Code writes one `<pid>.json` per running process here. */
  dir?: string;
  isAlive?: (pid: number) => boolean;
  /** True for processes Relay spawned (its SDK children). */
  isOwnDescendant?: (pid: number) => Promise<boolean>;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function parentOf(pid: number): Promise<number | null> {
  try {
    const { stdout } = await run('ps', ['-o', 'ppid=', '-p', String(pid)]);
    const ppid = Number(stdout.trim());
    return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

async function descendsFromSelf(pid: number): Promise<boolean> {
  let current: number | null = pid;
  for (let hops = 0; current !== null && current > 1 && hops < 16; hops += 1) {
    current = await parentOf(current);
    if (current === process.pid) return true;
  }
  return false;
}

/** Reads Claude Code's live-process registry (`~/.claude/sessions`). */
export class ClaudeSessionRegistry implements SessionRegistry {
  private readonly dir: string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly isOwnDescendant: (pid: number) => Promise<boolean>;

  constructor(opts: ClaudeSessionRegistryOptions = {}) {
    this.dir = opts.dir ?? join(homedir(), '.claude', 'sessions');
    this.isAlive = opts.isAlive ?? processAlive;
    this.isOwnDescendant = opts.isOwnDescendant ?? descendsFromSelf;
  }

  async openSessions(): Promise<Record<string, 'busy' | 'idle'>> {
    const open: Record<string, 'busy' | 'idle'> = {};
    for (const e of await this.foreignEntries()) {
      if (typeof e.sessionId !== 'string') continue;
      open[e.sessionId] = e.status === 'busy' || open[e.sessionId] === 'busy' ? 'busy' : 'idle';
    }
    return open;
  }

  async foreignHolders(sessionId: string): Promise<number[]> {
    return (await this.foreignEntries()).filter((e) => e.sessionId === sessionId).map((e) => e.pid);
  }

  /** Registry entries of live processes that are not Relay's own. */
  private async foreignEntries(): Promise<{ pid: number; sessionId?: unknown; status?: unknown }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const found: { pid: number; sessionId?: unknown; status?: unknown }[] = [];
    for (const name of names.filter((n) => /^\d+\.json$/.test(n)).sort()) {
      let entry: { pid?: unknown; sessionId?: unknown; status?: unknown };
      try {
        entry = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as typeof entry;
      } catch {
        continue;
      }
      if (typeof entry.pid !== 'number') continue;
      if (!this.isAlive(entry.pid) || (await this.isOwnDescendant(entry.pid))) continue;
      found.push({ ...entry, pid: entry.pid });
    }
    return found;
  }
}
