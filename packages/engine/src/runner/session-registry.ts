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
  /** Stops the processes holding a session so Relay can drive it; returns the pids stopped. */
  release?(sessionId: string): Promise<number[]>;
}

/**
 * Set in every process Relay starts a session from, and inherited by the agent it spawns.
 * A driver left behind by an earlier Relay is no longer reachable by parentage, so this is
 * what still identifies it as ours rather than as a terminal holding the session.
 */
export const RELAY_DRIVER_ENV = 'RELAY_HUB_DRIVER';

export interface ClaudeSessionRegistryOptions {
  /** Claude Code writes one `<pid>.json` per running process here. */
  dir?: string;
  isAlive?: (pid: number) => boolean;
  /** True for processes Relay spawned (its SDK children). */
  isOwnDescendant?: (pid: number) => Promise<boolean>;
  /** A live process's environment; used to recognise drivers Relay started. */
  readEnv?: (pid: number) => Promise<string>;
  /** True for a process Relay is running inside, which must never be stopped. */
  isOwnAncestor?: (pid: number) => Promise<boolean>;
  terminate?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long a stopped process is given to exit. */
  releaseTimeoutMs?: number;
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

async function ancestorOfSelf(pid: number): Promise<boolean> {
  let current: number | null = process.pid;
  for (let hops = 0; current !== null && current > 1 && hops < 16; hops += 1) {
    current = await parentOf(current);
    if (current === pid) return true;
  }
  return false;
}

async function environmentOf(pid: number): Promise<string> {
  const { stdout } = await run('ps', ['-Eww', '-p', String(pid)]);
  return stdout;
}

/** Reads Claude Code's live-process registry (`~/.claude/sessions`). */
export class ClaudeSessionRegistry implements SessionRegistry {
  private readonly dir: string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly isOwnDescendant: (pid: number) => Promise<boolean>;
  private readonly readEnv: (pid: number) => Promise<string>;
  private readonly isOwnAncestor: (pid: number) => Promise<boolean>;
  private readonly terminate: (pid: number) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly releaseTimeoutMs: number;

  constructor(opts: ClaudeSessionRegistryOptions = {}) {
    this.dir = opts.dir ?? join(homedir(), '.claude', 'sessions');
    this.isAlive = opts.isAlive ?? processAlive;
    this.isOwnDescendant = opts.isOwnDescendant ?? descendsFromSelf;
    this.readEnv = opts.readEnv ?? environmentOf;
    this.isOwnAncestor = opts.isOwnAncestor ?? ancestorOfSelf;
    this.terminate = opts.terminate ?? ((pid) => process.kill(pid, 'SIGTERM'));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.releaseTimeoutMs = opts.releaseTimeoutMs ?? 10_000;
  }

  /**
   * Asks the Claude processes holding a session to exit, and waits until they have.
   *
   * Claude Code shuts down on SIGTERM and removes its own registry entry, so the session is
   * free afterwards. A process Relay is running inside is refused: stopping it would stop Relay.
   */
  async release(sessionId: string): Promise<number[]> {
    const pids = await this.foreignHolders(sessionId);
    for (const pid of pids) {
      if (await this.isOwnAncestor(pid)) {
        throw new Error(`Session ${sessionId} is held by pid ${pid}, which Relay runs inside; close it there instead`);
      }
    }
    for (const pid of pids) {
      try {
        this.terminate(pid);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      }
    }
    const step = 200;
    for (let waited = 0; pids.some((pid) => this.isAlive(pid)); waited += step) {
      if (waited >= this.releaseTimeoutMs) {
        const left = pids.filter((pid) => this.isAlive(pid)).join(', ');
        throw new Error(`Claude process ${left} did not exit; close it there instead`);
      }
      await this.sleep(step);
    }
    return pids;
  }

  /** A process Relay started, now or in an earlier run; never a terminal the user is using. */
  private async isRelayDriver(pid: number): Promise<boolean> {
    try {
      return (await this.readEnv(pid)).includes(`${RELAY_DRIVER_ENV}=`);
    } catch {
      // an environment we cannot read belongs to somebody else as far as we know
      return false;
    }
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
      if (await this.isRelayDriver(entry.pid)) continue;
      found.push({ ...entry, pid: entry.pid });
    }
    return found;
  }
}
