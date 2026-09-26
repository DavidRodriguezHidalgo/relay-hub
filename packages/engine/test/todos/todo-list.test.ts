import { describe, expect, it } from 'vitest';
import type { Todo } from '@relay/shared';
import { TodoList, type TodoRecords } from '../../src/todos/todo-list';

/** An in-memory stand-in for the store, so the logic is tested without a database. */
function records(): TodoRecords & { rows: Map<string, Todo> } {
  const rows = new Map<string, Todo>();
  return {
    rows,
    allTodos: () => [...rows.values()],
    putTodo: (t) => void rows.set(t.id, t),
    removeTodo: (id) => void rows.delete(id),
  };
}

function listAt(times: string[] = ['2026-09-25T10:00:00.000Z']) {
  const store = records();
  let tick = 0;
  let seq = 0;
  const todos = new TodoList(
    store,
    () => times[Math.min(tick++, times.length - 1)]!,
    () => `id-${++seq}`,
  );
  return { todos, store };
}

describe('TodoList', () => {
  it('adds a todo that has not been launched yet', () => {
    const { todos } = listAt();
    const made = todos.create({ title: 'Activity log on vacancies' });
    expect(made).toMatchObject({
      id: 'id-1',
      title: 'Activity log on vacancies',
      notes: '',
      project: null,
      branch: null,
      sessionId: null,
      done: false,
      launchedAt: null,
    });
    expect(made.createdAt).toBe('2026-09-25T10:00:00.000Z');
  });

  it('keeps the context and target it was given', () => {
    const { todos } = listAt();
    const made = todos.create({ title: 'T', notes: 'what done looks like', project: '/repo', branch: 'feat/x' });
    expect(made).toMatchObject({ notes: 'what done looks like', project: '/repo', branch: 'feat/x' });
  });

  it('refuses a todo with no title, so the list cannot fill with blanks', () => {
    const { todos } = listAt();
    expect(() => todos.create({ title: '   ' })).toThrow(/title/i);
  });

  it('trims the title', () => {
    const { todos } = listAt();
    expect(todos.create({ title: '  spaced  ' }).title).toBe('spaced');
  });

  it('changes only the fields it is given', () => {
    const { todos } = listAt();
    const made = todos.create({ title: 'T', notes: 'n' });
    const after = todos.update(made.id, { done: true });
    expect(after).toMatchObject({ title: 'T', notes: 'n', done: true });
  });

  it('refuses to update a todo that is not there', () => {
    const { todos } = listAt();
    expect(() => todos.update('nope', { done: true })).toThrow(/nope/);
  });

  it('removes a todo', () => {
    const { todos } = listAt();
    const made = todos.create({ title: 'T' });
    todos.remove(made.id);
    expect(todos.list()).toEqual([]);
  });

  it('joins a todo to the session it became, and records when', () => {
    const { todos } = listAt(['2026-09-25T10:00:00.000Z', '2026-09-25T11:30:00.000Z']);
    const made = todos.create({ title: 'T' });
    const linked = todos.link(made.id, 'session-9');
    expect(linked.sessionId).toBe('session-9');
    expect(linked.launchedAt).toBe('2026-09-25T11:30:00.000Z');
  });

  it('puts what is still open before what is done', () => {
    const { todos } = listAt();
    const first = todos.create({ title: 'first' });
    todos.create({ title: 'second' });
    todos.update(first.id, { done: true });
    expect(todos.list().map((t) => t.title)).toEqual(['second', 'first']);
  });

  it('keeps the order work was added in', () => {
    const { todos } = listAt(['2026-09-25T10:00:00.000Z', '2026-09-25T10:00:01.000Z', '2026-09-25T10:00:02.000Z']);
    todos.create({ title: 'a' });
    todos.create({ title: 'b' });
    todos.create({ title: 'c' });
    expect(todos.list().map((t) => t.title)).toEqual(['a', 'b', 'c']);
  });

  it('finds one by id', () => {
    const { todos } = listAt();
    const made = todos.create({ title: 'T' });
    expect(todos.get(made.id)?.title).toBe('T');
    expect(todos.get('missing')).toBeNull();
  });
});

describe('TodoList ordering', () => {
  const titles = (t: TodoList) => t.list().map((x) => x.title);

  it('moves an item up, and the change sticks', () => {
    const { todos } = listAt(['2026-09-25T10:00:00.000Z', '2026-09-25T10:00:01.000Z', '2026-09-25T10:00:02.000Z']);
    todos.create({ title: 'a' });
    const b = todos.create({ title: 'b' });
    todos.create({ title: 'c' });
    todos.move(b.id, 'up');
    expect(titles(todos)).toEqual(['b', 'a', 'c']);
    expect(titles(todos)).toEqual(['b', 'a', 'c']);
  });

  it('moves an item down', () => {
    const { todos } = listAt(['2026-09-25T10:00:00.000Z', '2026-09-25T10:00:01.000Z', '2026-09-25T10:00:02.000Z']);
    const a = todos.create({ title: 'a' });
    todos.create({ title: 'b' });
    todos.create({ title: 'c' });
    todos.move(a.id, 'down');
    expect(titles(todos)).toEqual(['b', 'a', 'c']);
  });

  it('leaves the ends alone rather than wrapping around', () => {
    const { todos } = listAt(['2026-09-25T10:00:00.000Z', '2026-09-25T10:00:01.000Z']);
    const a = todos.create({ title: 'a' });
    const b = todos.create({ title: 'b' });
    todos.move(a.id, 'up');
    expect(titles(todos)).toEqual(['a', 'b']);
    todos.move(b.id, 'down');
    expect(titles(todos)).toEqual(['a', 'b']);
  });

  it('orders within what is still open, leaving what is done below it', () => {
    const { todos } = listAt(['2026-09-25T10:00:00.000Z', '2026-09-25T10:00:01.000Z', '2026-09-25T10:00:02.000Z']);
    const a = todos.create({ title: 'a' });
    const b = todos.create({ title: 'b' });
    const c = todos.create({ title: 'c' });
    todos.update(c.id, { done: true });
    todos.move(b.id, 'up');
    expect(titles(todos)).toEqual(['b', 'a', 'c']);
    expect(todos.list().at(-1)).toMatchObject({ id: c.id, done: true });
    void a;
  });

  it('keeps a new item at the end of the ones already ordered', () => {
    const { todos } = listAt(['2026-09-25T10:00:00.000Z', '2026-09-25T10:00:01.000Z', '2026-09-25T10:00:02.000Z']);
    todos.create({ title: 'a' });
    const b = todos.create({ title: 'b' });
    todos.move(b.id, 'up');
    todos.create({ title: 'c' });
    expect(titles(todos)).toEqual(['b', 'a', 'c']);
  });

  it('refuses to move a todo that is not there', () => {
    const { todos } = listAt();
    expect(() => todos.move('nope', 'up')).toThrow(/nope/);
  });
});
