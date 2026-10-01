import { join } from 'node:path';

/**
 * The model Claude Code will use when nobody asks for one.
 *
 * Relay does not use it: it asks for a model by name, so nothing it starts depends on this. It is
 * read only so the app can say which file it is leaving alone, and name what that file holds —
 * `/model` writes it, and sessions the user starts themselves still follow it.
 */
export const CLAUDE_SETTINGS = '.claude/settings.json';

/** Where the saved default lives, so the app can point at it rather than describing it. */
export function claudeSettingsPath(home: string): string {
  return join(home, CLAUDE_SETTINGS);
}

/**
 * Reads the saved default, or null when nothing is saved and Claude Code picks for itself.
 *
 * A missing or damaged file is not an error: it means no default has been chosen, which is the
 * state most machines are in.
 */
export function claudeDefaultModel(home: string, read: (path: string) => string): string | null {
  try {
    const parsed = JSON.parse(read(claudeSettingsPath(home))) as { model?: unknown } | null;
    const model = parsed?.model;
    return typeof model === 'string' && model !== '' ? model : null;
  } catch {
    return null;
  }
}
