import type { Invocable } from '@relay/shared';

/**
 * Commands Relay answers itself rather than passing to the session. They lead the `/` menu so
 * they are found next to the session's own, and a session never sees their text.
 */
export const RELAY_COMMANDS: readonly Invocable[] = [
  {
    name: 'btw',
    description: 'Ask a side question about the work without disturbing it; answered from a copy of the conversation',
    argumentHint: '<question>',
  },
];
