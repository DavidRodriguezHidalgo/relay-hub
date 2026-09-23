import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

describe('toolchain', () => {
  it('has node:sqlite', () => {
    const db = new DatabaseSync(':memory:');
    expect(db.prepare('select 1 as one').get()).toEqual({ one: 1 });
  });
});
