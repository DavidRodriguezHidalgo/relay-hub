import { describe, expect, it } from 'vitest';
import { contextUseFrom, limitFor, DEFAULT_CONTEXT_LIMIT } from '../../src/context/context-use';

const turn = (usage: Record<string, number>, over: Record<string, unknown> = {}) => ({
  type: 'assistant',
  timestamp: '2026-09-25T10:00:00.000Z',
  message: { role: 'assistant', model: 'claude-opus-5', usage },
  ...over,
});

describe('contextUseFrom', () => {
  it('counts everything the request carried, cache included', () => {
    const use = contextUseFrom([turn({ input_tokens: 2, cache_creation_input_tokens: 722, cache_read_input_tokens: 192_095 })]);
    expect(use?.tokens).toBe(192_819);
  });

  it('leaves the reply out: what was sent is what filled the window', () => {
    const use = contextUseFrom([turn({ input_tokens: 100, output_tokens: 5_000 })]);
    expect(use?.tokens).toBe(100);
  });

  it('reports the most recent request, not the first', () => {
    const use = contextUseFrom([turn({ input_tokens: 10 }), turn({ input_tokens: 40 })]);
    expect(use?.tokens).toBe(40);
  });

  it('works out a percentage of the window', () => {
    const use = contextUseFrom([turn({ input_tokens: 100_000 })]);
    expect(use?.limit).toBe(200_000);
    expect(use?.percent).toBe(50);
  });

  it('rounds to a whole percent rather than showing false precision', () => {
    expect(contextUseFrom([turn({ input_tokens: 192_819 })])?.percent).toBe(96);
  });

  it('never claims more than a full window', () => {
    expect(contextUseFrom([turn({ input_tokens: 400_000 })])?.percent).toBe(100);
  });

  it('keeps the model and the moment, so the number can be judged', () => {
    const use = contextUseFrom([turn({ input_tokens: 5 })]);
    expect(use?.model).toBe('claude-opus-5');
    expect(use?.at).toBe('2026-09-25T10:00:00.000Z');
  });

  it('has nothing to say about a session that never called the model', () => {
    expect(contextUseFrom([{ type: 'user', message: { role: 'user', content: 'hi' } }])).toBeNull();
    expect(contextUseFrom([])).toBeNull();
  });

  it('steps over records it cannot read rather than failing', () => {
    const use = contextUseFrom([null, 'nonsense', { message: null }, turn({ input_tokens: 7 })]);
    expect(use?.tokens).toBe(7);
  });
});

describe('limitFor', () => {
  it('assumes the usual window when the model is unknown', () => {
    expect(limitFor(null)).toBe(DEFAULT_CONTEXT_LIMIT);
    expect(limitFor('something-new')).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  it('recognises a long-context model', () => {
    expect(limitFor('claude-sonnet-4-5-1m')).toBe(1_000_000);
  });
});
