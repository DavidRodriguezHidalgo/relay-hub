import { describe, expect, it } from 'vitest';
import { explainApiError, hasGuidance } from '@relay/shared';

describe('explainApiError', () => {
  it('tells the person how to fix an expired login, rather than repeating the failure', () => {
    const text = explainApiError('authentication_failed', 'Failed to authenticate: OAuth session expired');
    expect(text).toMatch(/\/login/);
    expect(text).toMatch(/send again/);
    expect(hasGuidance('authentication_failed')).toBe(true);
  });

  it('falls back to the message for a failure it has no advice for', () => {
    expect(explainApiError('rate_limited', 'Too many requests')).toBe('Too many requests');
    expect(explainApiError(undefined, 'Something broke')).toBe('Something broke');
    expect(hasGuidance('rate_limited')).toBe(false);
  });
});
