import { z } from 'zod';
import type { DeliveryMode, Todo, TodoDraft, TodoPatch } from '@relay/shared';
import type { AgentTool, AgentToolResult } from '../runner/agent-client';

/** The todo list, as the orchestrator can reach it. Every call goes through the engine, so the panel sees it too. */
export interface TodoToolDeps {
  listTodos(): Todo[];
  createTodo(draft: TodoDraft): Todo[];
  updateTodo(id: string, patch: TodoPatch): Todo[];
  deleteTodo(id: string): Todo[];
  launchTodo(id: string): Promise<{ sessionId: string; todos: Todo[] }>;
  attachTodo(id: string, sessionId: string): Promise<{ mode: DeliveryMode; todos: Todo[] }>;
  /** The title of the session a todo became, for saying which one it is. */
  sessionTitle(sessionId: string): string | null;
}

const ok = (value: unknown): AgentToolResult => ({ text: JSON.stringify(value) });
const fail = (err: unknown): AgentToolResult => ({
  text: err instanceof Error ? err.message : String(err),
  isError: true,
});

/**
 * The orchestrator's view of one todo: what it is, and what became of it.
 *
 * Notes are the context a session is given when the item is launched, so they are worth the
 * room; the rest is what identifies the item and where its work went.
 */
function row(todo: Todo, sessionTitle: (id: string) => string | null) {
  return {
    id: todo.id,
    title: todo.title,
    notes: todo.notes,
    done: todo.done,
    project: todo.project,
    branch: todo.branch,
    sessionId: todo.sessionId,
    sessionTitle: todo.sessionId ? sessionTitle(todo.sessionId) : null,
    createdAt: todo.createdAt,
  };
}

/**
 * Tools for the work the user means to do.
 *
 * Reading, adding and editing are ordinary. Completing is offered freely because it can be
 * undone in the same breath. Deleting cannot be undone, so it is the one action with an
 * interlock: the caller has to quote the stored title back exactly, which it can only do by
 * having read that item, and it removes one item per call.
 */
export function createTodoTools(deps: TodoToolDeps): AgentTool[] {
  const titleOf = (id: string) => deps.sessionTitle(id);

  const listTodos: AgentTool<Record<string, never>> = {
    name: 'list_todos',
    description:
      "The user's todo list: work they mean to do, in the order the panel shows it. " +
      'Each item says whether it has become a session yet, and which.',
    input: {},
    handler: async () => {
      try {
        return ok({ todos: deps.listTodos().map((t) => row(t, titleOf)) });
      } catch (err) {
        return fail(err);
      }
    },
  };

  const addTodo: AgentTool<{ title: z.ZodString; notes: z.ZodOptional<z.ZodString> }> = {
    name: 'add_todo',
    description:
      'Add a piece of work to the todo list. title: in the user\'s own words. ' +
      'notes: context for whoever does it — what it is for, what done looks like. ' +
      'It is not started until start_todo_session or send_todo_to_session.',
    input: { title: z.string(), notes: z.string().optional() },
    handler: async ({ title, notes }) => {
      try {
        deps.createTodo({ title, ...(notes === undefined ? {} : { notes }) });
        return ok({ added: true, todos: deps.listTodos().map((t) => row(t, titleOf)) });
      } catch (err) {
        return fail(err);
      }
    },
  };

  const updateTodo: AgentTool<{
    id: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    notes: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    branch: z.ZodOptional<z.ZodString>;
  }> = {
    name: 'update_todo',
    description:
      'Change a todo. Only the fields given are touched. project is a repository root, branch the ' +
      'worktree a new session would get. Use complete_todo to tick one off.',
    input: {
      id: z.string(),
      title: z.string().optional(),
      notes: z.string().optional(),
      project: z.string().optional(),
      branch: z.string().optional(),
    },
    handler: async ({ id, ...fields }) => {
      try {
        const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as TodoPatch;
        if (Object.keys(patch).length === 0) return fail(new Error('Nothing to change: give at least one field.'));
        deps.updateTodo(id, patch);
        return ok({ updated: true, todos: deps.listTodos().map((t) => row(t, titleOf)) });
      } catch (err) {
        return fail(err);
      }
    },
  };

  const completeTodo: AgentTool<{ id: z.ZodString; done: z.ZodOptional<z.ZodBoolean> }> = {
    name: 'complete_todo',
    description: 'Tick a todo off, or put it back with done: false. Reversible either way.',
    input: { id: z.string(), done: z.boolean().optional() },
    handler: async ({ id, done }) => {
      try {
        deps.updateTodo(id, { done: done ?? true });
        return ok({ done: done ?? true, todos: deps.listTodos().map((t) => row(t, titleOf)) });
      } catch (err) {
        return fail(err);
      }
    },
  };

  const deleteTodo: AgentTool<{ id: z.ZodString; title: z.ZodString }> = {
    name: 'delete_todo',
    description:
      'Remove a todo for good. Only when the user asked for that item to be deleted; ticking it off with ' +
      'complete_todo is what "done" means and can be undone. Quote title back exactly as list_todos gives it, ' +
      'or the call is refused. One item per call.',
    input: { id: z.string(), title: z.string() },
    handler: async ({ id, title }) => {
      try {
        const found = deps.listTodos().find((t) => t.id === id);
        if (!found) return fail(new Error(`No todo ${id}. Read list_todos and use an id from it.`));
        if (found.title !== title) {
          return fail(new Error(`The title given does not match todo ${id}, which is "${found.title}". Nothing was deleted.`));
        }
        deps.deleteTodo(id);
        return ok({ deleted: true, todos: deps.listTodos().map((t) => row(t, titleOf)) });
      } catch (err) {
        return fail(err);
      }
    },
  };

  const startTodoSession: AgentTool<{
    id: z.ZodString;
    project: z.ZodOptional<z.ZodString>;
    branch: z.ZodOptional<z.ZodString>;
  }> = {
    name: 'start_todo_session',
    description:
      'Start a new Claude session for a todo and join the two: its title and notes become the first instruction. ' +
      'project and branch are only needed when the item has none yet; branch gives the session its own worktree. ' +
      'To use a session that is already open, use send_todo_to_session instead.',
    input: { id: z.string(), project: z.string().optional(), branch: z.string().optional() },
    handler: async ({ id, project, branch }) => {
      try {
        const patch: TodoPatch = {
          ...(project === undefined ? {} : { project }),
          ...(branch === undefined ? {} : { branch }),
        };
        if (Object.keys(patch).length > 0) deps.updateTodo(id, patch);
        const started = await deps.launchTodo(id);
        return ok({ started: true, sessionId: started.sessionId, todos: started.todos.map((t) => row(t, titleOf)) });
      } catch (err) {
        return fail(err);
      }
    },
  };

  const sendTodoToSession: AgentTool<{ id: z.ZodString; sessionId: z.ZodString }> = {
    name: 'send_todo_to_session',
    description:
      'Hand a todo to a session that is already open, rather than starting a new one — use when that session is ' +
      'already in the right repository with the context loaded. A session mid-turn queues it behind its current ' +
      'work; the answer says which happened.',
    input: { id: z.string(), sessionId: z.string() },
    handler: async ({ id, sessionId }) => {
      try {
        const sent = await deps.attachTodo(id, sessionId);
        return ok({
          attached: true,
          sessionId,
          delivery: sent.mode === 'queue' ? 'queue' : 'now',
          todos: sent.todos.map((t) => row(t, titleOf)),
        });
      } catch (err) {
        return fail(err);
      }
    },
  };

  return [listTodos, addTodo, updateTodo, completeTodo, deleteTodo, startTodoSession, sendTodoToSession] as unknown as AgentTool[];
}
