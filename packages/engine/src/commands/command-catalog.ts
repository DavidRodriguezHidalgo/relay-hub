import type { AgentCapabilities } from '../runner/agent-client';

/** Asks the agent runtime what a directory offers; `undefined` when it cannot be asked. */
export type DescribeCommands = ((cwd: string) => Promise<AgentCapabilities>) | undefined;

const NOTHING: AgentCapabilities = { commands: [], models: [] };

/**
 * What each directory can be asked to run, cached per directory.
 *
 * Commands, skills and plugins come from the agent runtime itself rather than a scan of
 * `.claude`, so built-ins and plugin-qualified names are included exactly as the session
 * will accept them. A lookup that fails is not cached, so a passing runtime is picked up later.
 */
export class CommandCatalog {
  private readonly cache = new Map<string, AgentCapabilities>();
  private readonly inFlight = new Map<string, Promise<AgentCapabilities>>();

  constructor(private readonly describe: DescribeCommands) {}

  async list(cwd: string): Promise<AgentCapabilities> {
    const cached = this.cache.get(cwd);
    if (cached) return cached;
    const describe = this.describe;
    if (!describe) return NOTHING;
    let pending = this.inFlight.get(cwd);
    if (!pending) {
      pending = describe(cwd)
        .then((commands) => {
          this.cache.set(cwd, commands);
          return commands;
        })
        .catch(() => NOTHING)
        .finally(() => this.inFlight.delete(cwd));
      this.inFlight.set(cwd, pending);
    }
    return pending;
  }
}
