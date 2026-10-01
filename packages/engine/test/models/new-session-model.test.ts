import { describe, expect, it } from 'vitest';
import type { ModelChoice } from '@relay/shared';
import { newSessionModel, recommendedModel } from '../../src/models/new-session-model';

const m = (id: string, resolvedModel: string): ModelChoice => ({
  id, name: id, description: '', resolvedModel, current: false,
});

/** The shape the real source returns, recommended entry first. */
const LIST = [
  m('default', 'claude-opus-5[1m]'),
  m('opus[1m]', 'claude-opus-5[1m]'),
  m('claude-fable-5-1[1m]', 'claude-fable-5-1'),
  m('sonnet', 'claude-sonnet-5'),
];

describe('recommendedModel', () => {
  it('takes the option the source marks, not the first one it happens to list', () => {
    const shuffled = [LIST[3]!, LIST[0]!, LIST[1]!];
    expect(recommendedModel(shuffled)?.id).toBe('default');
  });

  it('falls back to the first option when nothing is marked, since these lists lead with the everyday choice', () => {
    expect(recommendedModel([LIST[1]!, LIST[3]!])?.id).toBe('opus[1m]');
  });

  it('does not call an unmarked first option recommended, because the source never recommended it', () => {
    expect(newSessionModel(null, [LIST[1]!, LIST[3]!])).toEqual({
      id: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', source: 'first-listed',
    });
  });

  it('has nothing to offer from an empty list', () => {
    expect(recommendedModel([])).toBeNull();
  });
});

describe('newSessionModel', () => {
  it('asks for the recommended option when the user has chosen nothing, rather than asking for nothing', () => {
    expect(newSessionModel(null, LIST)).toEqual({
      id: 'default',
      resolvedModel: 'claude-opus-5[1m]',
      source: 'recommended',
    });
  });

  it('asks for what the user chose', () => {
    expect(newSessionModel('sonnet', LIST)).toEqual({
      id: 'sonnet',
      resolvedModel: 'claude-sonnet-5',
      source: 'chosen',
    });
  });

  it('still asks for a choice the list no longer offers, rather than quietly substituting one', () => {
    expect(newSessionModel('retired-model', LIST)).toEqual({
      id: 'retired-model',
      resolvedModel: null,
      source: 'chosen',
    });
  });

  it('asks for nothing only when there is no list to choose from, and says the answer is unknown', () => {
    expect(newSessionModel(null, [])).toEqual({ id: null, resolvedModel: null, source: 'unknown' });
  });
});
