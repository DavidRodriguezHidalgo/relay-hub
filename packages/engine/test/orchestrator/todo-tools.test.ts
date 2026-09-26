import { describe, expect, it, vi } from 'vitest';
import type { Todo } from '@relay/shared';
import { createTodoTools, type TodoToolDeps } from '../../src/orchestrator/todo-tools';

const todo = (over: Partial<Todo>): Todo => ({
  id: 't1', title: 'Add error monitoring', notes: '', project: null, branch: null,
  sessionId: null, done: false, createdAt: '2026-09-25T12:54:01.593Z', launchedAt: null, ...over,
});

function tools(over: Partial<TodoToolDeps> = {}) {
  const deps: TodoToolDeps = {
    listTodos: () => [todo({})],
    createTodo: vi.fn(() => [todo({})]),
    updateTodo: vi.fn(() => [todo({})]),
    deleteTodo: vi.fn(() => []),
    launchTodo: vi.fn(async () => ({ sessionId: 's9', todos: [todo({ sessionId: 's9' })] })),
    attachTodo: vi.fn(async () => ({ mode: 'queue' as const, todos: [todo({ sessionId: 's9' })] })),
    sessionTitle: () => 'Mileage work',
    ...over,
  };
  const byName = Object.fromEntries(createTodoTools(deps).map((t) => [t.name, t]));
  return { deps, byName };
}
const call = (t: { handler: (a: never) => Promise<{ text: string; isError?: boolean }> }, args: unknown) =>
  t.handler(args as never);

describe('todo tools', () => {
  it('gives the chat the same tools the panel has, and no others', () => {
    expect(Object.keys(tools().byName).sort()).toEqual(
      ['add_todo', 'complete_todo', 'delete_todo', 'list_todos', 'send_todo_to_session', 'start_todo_session', 'update_todo'].sort(),
    );
  });

  it('lists what is stored, saying which session each became', async () => {
    const { byName } = tools({ listTodos: () => [todo({ id: 'a', sessionId: 's9' }), todo({ id: 'b' })] });
    const out = JSON.parse((await call(byName.list_todos!, {})).text) as { todos: unknown[] };
    expect(out.todos).toEqual([
      expect.objectContaining({ id: 'a', sessionId: 's9', sessionTitle: 'Mileage work' }),
      expect.objectContaining({ id: 'b', sessionId: null, sessionTitle: null }),
    ]);
  });

  it('adds a todo with the words it was given', async () => {
    const { deps, byName } = tools();
    await call(byName.add_todo!, { title: 'Set up CI in github' });
    expect(deps.createTodo).toHaveBeenCalledWith({ title: 'Set up CI in github' });
  });

  it('changes only the fields it was asked to change', async () => {
    const { deps, byName } = tools();
    await call(byName.update_todo!, { id: 't1', notes: 'free tier only' });
    expect(deps.updateTodo).toHaveBeenCalledWith('t1', { notes: 'free tier only' });
  });

  it('completes an item, and can put it back, because that is reversible', async () => {
    const { deps, byName } = tools();
    await call(byName.complete_todo!, { id: 't1' });
    expect(deps.updateTodo).toHaveBeenCalledWith('t1', { done: true });
    await call(byName.complete_todo!, { id: 't1', done: false });
    expect(deps.updateTodo).toHaveBeenCalledWith('t1', { done: false });
  });

  it('refuses to delete unless the exact stored title is quoted back', async () => {
    const { deps, byName } = tools();
    const out = await call(byName.delete_todo!, { id: 't1', title: 'the monitoring one' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/does not match/i);
    expect(deps.deleteTodo).not.toHaveBeenCalled();
  });

  it('deletes when the title matches exactly', async () => {
    const { deps, byName } = tools();
    const out = await call(byName.delete_todo!, { id: 't1', title: 'Add error monitoring' });
    expect(out.isError).toBeUndefined();
    expect(deps.deleteTodo).toHaveBeenCalledWith('t1');
  });

  it('will not delete a todo it cannot find, rather than guessing', async () => {
    const { deps, byName } = tools();
    const out = await call(byName.delete_todo!, { id: 'nope', title: 'Add error monitoring' });
    expect(out.isError).toBe(true);
    expect(deps.deleteTodo).not.toHaveBeenCalled();
  });

  it('starts a session for an item, through the same path the panel uses', async () => {
    const { deps, byName } = tools();
    const out = JSON.parse((await call(byName.start_todo_session!, { id: 't1', project: '/repo', branch: 'feat/x' })).text) as Record<string, unknown>;
    expect(deps.updateTodo).toHaveBeenCalledWith('t1', { project: '/repo', branch: 'feat/x' });
    expect(deps.launchTodo).toHaveBeenCalledWith('t1');
    expect(out).toMatchObject({ sessionId: 's9' });
  });

  it('does not touch the stored project when starting without one', async () => {
    const { deps, byName } = tools();
    await call(byName.start_todo_session!, { id: 't1' });
    expect(deps.updateTodo).not.toHaveBeenCalled();
    expect(deps.launchTodo).toHaveBeenCalledWith('t1');
  });

  it('hands an item to a session already open, and says whether it was queued', async () => {
    const { deps, byName } = tools();
    const out = JSON.parse((await call(byName.send_todo_to_session!, { id: 't1', sessionId: 's9' })).text) as Record<string, unknown>;
    expect(deps.attachTodo).toHaveBeenCalledWith('t1', 's9');
    expect(out).toMatchObject({ attached: true, sessionId: 's9', delivery: 'queue' });
  });

  it('passes a refusal back as an error instead of claiming success', async () => {
    const { byName } = tools({ launchTodo: vi.fn(async () => { throw new Error('Choose a project for "x" before launching it.'); }) });
    const out = await call(byName.start_todo_session!, { id: 't1' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Choose a project/);
  });
});
