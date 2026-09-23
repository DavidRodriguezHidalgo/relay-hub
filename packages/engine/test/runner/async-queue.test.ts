import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../../src/runner/async-queue';

async function drain<T>(q: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of q) out.push(x);
  return out;
}

describe('AsyncQueue', () => {
  it('yields pushed items in order and finishes on end()', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    const done = drain(q);
    q.push(3);
    q.end();
    expect(await done).toEqual([1, 2, 3]);
  });

  it('waits for an item pushed later', async () => {
    const q = new AsyncQueue<string>();
    const it = q[Symbol.asyncIterator]();
    const next = it.next();
    setTimeout(() => q.push('late'), 10);
    expect(await next).toEqual({ value: 'late', done: false });
    q.end();
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  it('ignores pushes after end and reports size', () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    expect(q.size).toBe(1);
    q.end();
    q.push(2);
    expect(q.size).toBe(1);
  });
});
