import { randomUUID } from 'node:crypto';
import type { Todo, TodoDraft, TodoPatch } from '@relay/shared';

/** The slice of the store this needs, so the logic can be exercised without a database. */
export interface TodoRecords {
  allTodos(): Todo[];
  putTodo(todo: Todo): void;
  removeTodo(id: string): void;
}

/** Where a todo sits: the place it was given, else when it was added. */
const placeOf = (t: Todo) => t.position ?? Number.MAX_SAFE_INTEGER;
const inOrder = (a: Todo, b: Todo) => placeOf(a) - placeOf(b) || a.createdAt.localeCompare(b.createdAt);

/**
 * The work you intend to do, in the order you meant to do it.
 *
 * A todo carries no state of its own once launched: what the session is doing is read from the
 * session, so the two can never disagree. All this keeps is the intention and the link.
 */
export class TodoList {
  constructor(
    private readonly records: TodoRecords,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = () => randomUUID(),
  ) {}

  /** Still open first, then what is done; each in the order chosen, or the order added. */
  list(): Todo[] {
    const all = this.records.allTodos();
    return [...all.filter((t) => !t.done).sort(inOrder), ...all.filter((t) => t.done).sort(inOrder)];
  }

  /**
   * Moves one todo a place up or down among the others in its half of the list.
   *
   * Moving renumbers that half outright rather than nudging one value, so the order it leaves
   * behind is the order that was on screen — no drift, and no two items claiming one place.
   */
  move(id: string, direction: 'up' | 'down'): Todo[] {
    const todo = this.require(id);
    const group = this.list().filter((t) => t.done === todo.done);
    const from = group.findIndex((t) => t.id === id);
    const to = direction === 'up' ? from - 1 : from + 1;
    if (to < 0 || to >= group.length) return this.list();
    const moved = [...group];
    moved.splice(to, 0, ...moved.splice(from, 1));
    moved.forEach((t, position) => this.records.putTodo({ ...t, position }));
    return this.list();
  }

  get(id: string): Todo | null {
    return this.records.allTodos().find((t) => t.id === id) ?? null;
  }

  create(draft: TodoDraft): Todo {
    const title = draft.title.trim();
    if (!title) throw new Error('A todo needs a title.');
    const todo: Todo = {
      id: this.newId(),
      title,
      notes: draft.notes ?? '',
      project: draft.project ?? null,
      branch: draft.branch ?? null,
      sessionId: null,
      done: false,
      createdAt: this.clock(),
      launchedAt: null,
    };
    this.records.putTodo(todo);
    return todo;
  }

  update(id: string, patch: TodoPatch): Todo {
    const todo = this.require(id);
    const next: Todo = { ...todo, ...patch };
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new Error('A todo needs a title.');
      next.title = title;
    }
    this.records.putTodo(next);
    return next;
  }

  remove(id: string): void {
    this.records.removeTodo(id);
  }

  /** Joins a todo to the session it became. */
  link(id: string, sessionId: string): Todo {
    const next: Todo = { ...this.require(id), sessionId, launchedAt: this.clock() };
    this.records.putTodo(next);
    return next;
  }

  /** Lets a todo go of its session, so it can be handed somewhere else. */
  unlink(id: string): Todo {
    const next: Todo = { ...this.require(id), sessionId: null, launchedAt: null };
    this.records.putTodo(next);
    return next;
  }

  private require(id: string): Todo {
    const todo = this.get(id);
    if (!todo) throw new Error(`No todo ${id}.`);
    return todo;
  }
}
