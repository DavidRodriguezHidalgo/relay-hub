import { describe, expect, it } from 'vitest';
import type { Invocable } from '@relay/shared';
import { routeSlash } from './slashRouting';

const cmd = (name: string): Invocable => ({ name, description: '', argumentHint: '' });
const session = [cmd('review'), cmd('superpowers:brainstorming')];

describe('routeSlash', () => {
  it('leaves ordinary text alone', () => {
    expect(routeSlash('just a message', session)).toEqual({ kind: 'not-a-command' });
    expect(routeSlash('half / way through', session)).toEqual({ kind: 'not-a-command' });
    expect(routeSlash('/', session)).toEqual({ kind: 'not-a-command' });
  });

  it('keeps the commands Relay owns away from the session', () => {
    expect(routeSlash('/btw why sqlite?', session)).toEqual({ kind: 'app', name: 'btw', argument: 'why sqlite?' });
    expect(routeSlash('/model', session)).toEqual({ kind: 'app', name: 'model', argument: '' });
    expect(routeSlash('/model sonnet', session)).toEqual({ kind: 'app', name: 'model', argument: 'sonnet' });
  });

  it('passes a command the session owns through on purpose', () => {
    expect(routeSlash('/review 3497', session)).toEqual({ kind: 'session', name: 'review' });
    expect(routeSlash('/brainstorming an idea', session)).toEqual({ kind: 'session', name: 'brainstorming' });
    expect(routeSlash('/superpowers:brainstorming go', session)).toEqual({ kind: 'session', name: 'superpowers:brainstorming' });
  });

  it('refuses a command nobody owns, rather than sending it on as an instruction', () => {
    expect(routeSlash('/modle sonnet', session)).toEqual({ kind: 'unknown', name: 'modle' });
    expect(routeSlash('/deploy', session)).toEqual({ kind: 'unknown', name: 'deploy' });
  });

  it('passes commands through while the session has not said what it offers', () => {
    expect(routeSlash('/review', [])).toEqual({ kind: 'session', name: 'review' });
    expect(routeSlash('/btw hello', [])).toEqual({ kind: 'app', name: 'btw', argument: 'hello' });
  });
});
