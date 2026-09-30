import { describe, expect, it } from 'vitest';
import { classifyFailure, describeFailure, resetsAt } from '../../src/failures/classify';

describe('classifyFailure', () => {
  it('names an expired login, so it reads as something to fix rather than a bug', () => {
    expect(classifyFailure('Failed to authenticate: OAuth session expired', 'authentication_failed'))
      .toBe('authentication');
  });

  it('recognises a usage limit, which resets on its own', () => {
    for (const text of [
      'Claude usage limit reached',
      'You have hit the rate limit for this model',
      'API Error: 429 Too Many Requests',
      'quota exceeded for this organisation',
    ]) {
      expect(classifyFailure(text), text).toBe('usage-limit');
    }
  });

  it('prefers a usage limit over a bare api error, because the answer is to wait', () => {
    expect(classifyFailure('API Error: 429 rate limit', 'rate_limited')).toBe('usage-limit');
  });

  it('calls an unrecognised api failure a crash rather than guessing further', () => {
    expect(classifyFailure('Something went wrong', 'overloaded')).toBe('crash');
  });

  it('spots trouble that came from a tool', () => {
    expect(classifyFailure('Bash command failed with exit code 127')).toBe('tool');
    expect(classifyFailure('spawn ENOENT')).toBe('tool');
  });

  it('reads the result subtype a failed run carries, which is a code and not wording', () => {
    expect(classifyFailure('error_during_execution: process exited')).toBe('crash');
    // the turn cap is not a crash, and nothing structured says more than the message does
    expect(classifyFailure('error_max_turns: reached the limit')).toBe('unknown');
  });

  it('says unknown rather than inventing a cause', () => {
    expect(classifyFailure('the wheels came off')).toBe('unknown');
    expect(classifyFailure('')).toBe('unknown');
  });
});

describe('resetsAt', () => {
  it('picks up the time a limit says it lifts', () => {
    expect(resetsAt('Usage limit reached. Resets at 3pm')).toBe('3pm');
    expect(resetsAt('limit reached, resets 09:30')).toBe('09:30');
  });

  it('says nothing when the message does not', () => {
    expect(resetsAt('Usage limit reached')).toBeUndefined();
  });
});

describe('describeFailure', () => {
  it('keeps the record short enough to sit in a listing', () => {
    const long = 'x'.repeat(400);
    const f = describeFailure(long, '2026-09-30T10:00:00.000Z');
    expect(f.message).toHaveLength(161);
    expect(f.message.endsWith('…')).toBe(true);
  });

  it('flattens the whitespace a stack trace brings with it', () => {
    expect(describeFailure('failed\n   at foo\n   at bar', '2026-09-30T10:00:00.000Z').message)
      .toBe('failed at foo at bar');
  });

  it('carries the reset time only for a usage limit', () => {
    expect(describeFailure('Usage limit reached. Resets at 3pm', 'now')).toMatchObject({
      kind: 'usage-limit',
      resetsAt: '3pm',
    });
    expect(describeFailure('crashed, resets at 3pm', 'now', 'x').resetsAt).toBeUndefined();
  });
});
