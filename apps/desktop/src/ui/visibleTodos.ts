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
  /** The row opened for editing, kept whatever its place, so it cannot vanish mid-edit. */
  openId?: string | null;
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
 * Position alone is not enough: a todo whose session is working, or waiting for an approval, is
 * the one you would most want to find, so it stays on the list wherever it sits.
 */
export function visibleTodos(todos: Todo[], opts: TodoVisibility): TodoSplit {
  if (opts.showAll) return { shown: todos, hidden: 0 };
  const live = (todo: Todo) => {
    if (!todo.sessionId) return false;
    const session = opts.sessions.find((s) => s.id === todo.sessionId);
    return session ? isActive(dotState(session.id, opts.states, opts.external)) : false;
  };
  const keep = new Set<string>();
  for (const todo of todos) {
    if (keep.size < TODOS_SHOWN || live(todo) || todo.id === opts.openId) keep.add(todo.id);
  }
  const shown = todos.filter((t) => keep.has(t.id));
  return { shown, hidden: todos.length - shown.length };
}
