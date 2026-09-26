import { describe, expect, it } from 'vitest';
import { modelInEffect, modelLabel } from '@relay/shared';

describe('modelInEffect', () => {
  it('prefers a model set for this session, because that is what it will run on next', () => {
    expect(modelInEffect('claude-opus-5', 'claude-sonnet-4-5')).toEqual({ id: 'claude-opus-5', source: 'chosen' });
  });

  it('otherwise reports what the last request actually ran on', () => {
    expect(modelInEffect(null, 'claude-sonnet-4-5')).toEqual({ id: 'claude-sonnet-4-5', source: 'last-run' });
  });

  it('says nothing rather than naming a default for a session that has never run', () => {
    expect(modelInEffect(null, null)).toBeNull();
  });
});

describe('modelLabel', () => {
  it('reads an id the way a person says it', () => {
    expect(modelLabel('claude-opus-5')).toBe('Opus 5');
    expect(modelLabel('claude-sonnet-4-5')).toBe('Sonnet 4.5');
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
  });

  it('keeps a variant marker as it is', () => {
    expect(modelLabel('claude-opus-5[1m]')).toBe('Opus 5 [1m]');
  });

  it('works on a short id with no prefix', () => {
    expect(modelLabel('opus')).toBe('Opus');
  });

  it('shows an unfamiliar id exactly as it is set, rather than tidying it into something else', () => {
    expect(modelLabel('some-internal-preview-x')).toBe('some-internal-preview-x');
    expect(modelLabel('gpt-4o')).toBe('gpt-4o');
  });
});
