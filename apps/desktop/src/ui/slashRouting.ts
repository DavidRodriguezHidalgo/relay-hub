import type { Invocable } from '@relay/shared';

/**
 * What the app does with a message that starts with a slash.
 *
 * `app` means Relay answers it and the session never sees the text. `session` means it is a
 * command the session itself owns and is passed through deliberately. `unknown` means no one
 * owns it, and it is refused rather than sent on as an instruction — which is how a typed
 * `/model` once reached a session as plain text and switched its model with no menu.
 */
export type SlashRoute =
  | { kind: 'not-a-command' }
  | { kind: 'app'; name: string; argument: string }
  | { kind: 'session'; name: string }
  | { kind: 'unknown'; name: string };

/** Commands Relay answers itself. Anything else belongs to the session, or to no one. */
const APP_COMMANDS = ['btw', 'model'] as const;

export function routeSlash(text: string, sessionCommands: Invocable[]): SlashRoute {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return { kind: 'not-a-command' };

  const match = trimmed.match(/^\/([^\s]*)(?:\s+([\s\S]*))?$/);
  const name = match?.[1] ?? '';
  const argument = (match?.[2] ?? '').trim();
  if (name === '') return { kind: 'not-a-command' };

  if ((APP_COMMANDS as readonly string[]).includes(name)) return { kind: 'app', name, argument };
  // a session's own command, by its full name or its plugin-qualified one
  // an empty list means the session has not been asked yet, not that it offers nothing
  if (sessionCommands.length === 0) return { kind: 'session', name };
  const owned = sessionCommands.some((c) => c.name === name || c.name.endsWith(`:${name}`));
  return owned ? { kind: 'session', name } : { kind: 'unknown', name };
}
