import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The @relay/* packages this app depends on, read from its own manifest so the list cannot drift. */
export function workspacePackages(manifestDir: string = __dirname): string[] {
  const pkg = JSON.parse(readFileSync(join(manifestDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => name.startsWith('@relay/'));
}
