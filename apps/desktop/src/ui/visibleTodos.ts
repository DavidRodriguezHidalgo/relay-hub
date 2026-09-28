import type { ExternalSessions, RunState, SessionSummary, Todo } from '@relay/shared';
import { dotState, isActive } from './sessionDot';

/**
 * How many todos the list shows before it starts holding the rest back.
 *
 * The list is a staging area for work you mean to do; the sessions below it are what you use all
 * day. Five is enough to see what is next without the list growing until the sessions are off
 * the bottom of the panel.
 */
export const TODOS_SHOWN = 5;

export interface TodoVisibility {
  states?: RunState['states'];
  external?: ExternalSessions;
  sessions: SessionSummary[];
  /**
   * Rows the person is in the middle of using — expanded, renamed, launching, being sent
   * somewhere. Kept wherever they sit, because a row cannot be allowed to unmount under a hand:
   * React fires no blur on unmount, so a half-typed rename would be lost without a word.
   */
  pinned?: readonly (string | null | undefined)[];
  showAll: boolean;
}

export interface TodoSplit {
  shown: Todo[];
  /** How many are held back, for saying so out loud. */
  hidden: number;
}

/**
 * Narrows the list to what is worth seeing, keeping the order it was given.
 *
 * Position alone is not enough. A todo whose session is working, waiting for an approval, or
 * running in another Claude process is the one you would most want to find, so it stays on the
 * list wherever it sits — as does any row the person is currently using.
 */
export function visibleTodos(todos: Todo[], opts: TodoVisibility): TodoSplit {
  if (opts.showAll) return { shown: todos, hidden: 0 };
  const live = (todo: Todo) => {
    if (!todo.sessionId) return false;
    const session = opts.sessions.find((s) => s.id === todo.sessionId);
    return session ? isActive(dotState(session.id, opts.states, opts.external)) : false;
  };
  const pinned = new Set((opts.pinned ?? []).filter((id): id is string => typeof id === 'string'));
  const keep = new Set<string>();
  for (const todo of todos) {
    if (keep.size < TODOS_SHOWN || live(todo) || pinned.has(todo.id)) keep.add(todo.id);
  }
  const shown = todos.filter((t) => keep.has(t.id));
  return { shown, hidden: todos.length - shown.length };
}
