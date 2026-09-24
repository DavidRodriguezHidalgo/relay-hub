import { describe, expect, it } from 'vitest';
import { idLookup } from './sessionLinks';

const A = 'e869a7c6-ed5f-4f2b-8bdd-2ad9bbf90344';
const B = 'e869a7c6-0000-0000-0000-000000000000';
const C = '12913fb8-62ba-439e-95c5-16a7199a1e8d';

describe('idLookup', () => {
  it('knows a session by its full id and by the short form Relay writes', () => {
    const lookup = idLookup([{ id: A }]);
    expect(lookup.get(A)).toBe(A);
    expect(lookup.get('e869a7c6')).toBe(A);
  });

  it('leaves a short form out when two sessions would answer to it', () => {
    const lookup = idLookup([{ id: A }, { id: B }, { id: C }]);
    expect(lookup.get('e869a7c6')).toBeUndefined();
    expect(lookup.get(A)).toBe(A);
    expect(lookup.get(B)).toBe(B);
    expect(lookup.get('12913fb8')).toBe(C);
  });
});
