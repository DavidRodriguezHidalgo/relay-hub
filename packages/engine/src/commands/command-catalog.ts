import type { Invocable } from '@relay/shared';

/** Asks the agent runtime what a directory offers; `undefined` when it cannot be asked. */
export type DescribeCommands = ((cwd: string) => Promise<Invocable[]>) | undefined;

/**
 * What each directory can be asked to run, cached per directory.
 *
 * Commands, skills and plugins come from the agent runtime itself rather than a scan of
 * `.claude`, so built-ins and plugin-qualified names are included exactly as the session
 * will accept them. A lookup that fails is not cached, so a passing runtime is picked up later.
 */
export class CommandCatalog {
  private readonly cache = new Map<string, Invocable[]>();
  private readonly inFlight = new Map<string, Promise<Invocable[]>>();

  constructor(private readonly describe: DescribeCommands) {}

  async list(cwd: string): Promise<Invocable[]> {
    const cached = this.cache.get(cwd);
    if (cached) return cached;
    const describe = this.describe;
    if (!describe) return [];
    let pending = this.inFlight.get(cwd);
    if (!pending) {
      pending = describe(cwd)
        .then((commands) => {
          this.cache.set(cwd, commands);
          return commands;
        })
        .catch(() => [])
        .finally(() => this.inFlight.delete(cwd));
      this.inFlight.set(cwd, pending);
    }
    return pending;
  }
}
