import { describe, expect, it } from 'vitest';
import type { SessionSummary, Todo } from '@relay/shared';
import { TODOS_SHOWN, visibleTodos } from './visibleTodos';

const todo = (over: Partial<Todo>): Todo => ({
  id: 't', title: 'work', notes: '', project: '/repo', branch: null, sessionId: null,
  done: false, createdAt: '2026-09-25T10:00:00.000Z', launchedAt: null, ...over,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => todo({ id: `t${i}`, title: `work ${i}` }));
const session = (id: string): SessionSummary => ({
  id, filePath: '/f', cwd: '/c', cwdExists: true, repo: 'repo', branch: 'b', title: 'T',
  lastActivity: '2026-09-25T10:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null,
  continuedIn: null, context: null, isStale: false,
});
const split = (todos: Todo[], over = {}) => visibleTodos(todos, { sessions: [], showAll: false, ...over });

describe('visibleTodos', () => {
  it('shows a short list whole', () => {
    expect(split(many(3)).shown).toHaveLength(3);
    expect(split(many(3)).hidden).toBe(0);
  });

  it('holds back the rest of a long list, and counts them', () => {
    const out = split(many(20));
    expect(out.shown).toHaveLength(TODOS_SHOWN);
    expect(out.hidden).toBe(15);
    expect(out.shown.map((t) => t.id)).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });

  it('keeps a todo whose session is working, wherever it sits in the list', () => {
    const list = [...many(10), todo({ id: 'live', sessionId: 's1' })];
    const out = split(list, { sessions: [session('s1')], states: { s1: { state: 'running', error: null } } });
    expect(out.shown.map((t) => t.id)).toContain('live');
    expect(out.hidden).toBe(list.length - out.shown.length);
  });

  it('keeps one waiting on an approval too', () => {
    const list = [...many(10), todo({ id: 'live', sessionId: 's1' })];
    const out = split(list, { sessions: [session('s1')], states: { s1: { state: 'waiting-approval', error: null } } });
    expect(out.shown.map((t) => t.id)).toContain('live');
  });

  it('does not keep one whose session is merely idle', () => {
    const list = [...many(10), todo({ id: 'quiet', sessionId: 's1' })];
    const out = split(list, { sessions: [session('s1')], states: { s1: { state: 'idle', error: null } } });
    expect(out.shown.map((t) => t.id)).not.toContain('quiet');
  });

  it('keeps the row being edited, so it cannot vanish mid-edit', () => {
    const out = split(many(20), { openId: 't15' });
    expect(out.shown.map((t) => t.id)).toContain('t15');
  });

  it('shows everything once asked, and then holds nothing back', () => {
    const out = split(many(20), { showAll: true });
    expect(out.shown).toHaveLength(20);
    expect(out.hidden).toBe(0);
  });

  it('keeps the order it was given, so the order you chose still decides', () => {
    expect(split([todo({ id: 'b' }), todo({ id: 'a' })]).shown.map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('has nothing to hide when there is nothing', () => {
    expect(split([])).toEqual({ shown: [], hidden: 0 });
  });
});
