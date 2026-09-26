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

describe('a pasted path is not a command', () => {
  const paths = [
    '/Users/david.rodriguez/Desktop/Screenshot 2026-09-26 at 17.27.08.png',
    '/Users/david.rodriguez/code/relay-hub',
    '/tmp/relay-sink-abc/crash-reporting.json',
    '/var/folders/4m/x9tg14bd/T/probe.txt',
    '/etc/hosts',
    '/screenshot.png',
    '/notes.md look at this',
  ];

  it.each(paths)('sends %s instead of refusing it', (text) => {
    expect(routeSlash(text, [cmd('review')])).toEqual({ kind: 'not-a-command' });
  });

  it('is not fooled by a path with spaces in it, which is the common case here', () => {
    const pasted = '/Users/david.rodriguez/Desktop/Screenshot 2026-09-26 at 17.27.08.png';
    expect(routeSlash(pasted, [])).toEqual({ kind: 'not-a-command' });
  });

  it('still treats a real command as one', () => {
    expect(routeSlash('/model', [])).toMatchObject({ kind: 'app', name: 'model' });
    expect(routeSlash('/btw why sqlite?', [])).toMatchObject({ kind: 'app', name: 'btw' });
    expect(routeSlash('/review', [cmd('review')])).toEqual({ kind: 'session', name: 'review' });
    expect(routeSlash('/superpowers:brainstorming', [cmd('superpowers:brainstorming')])).toEqual({
      kind: 'session',
      name: 'superpowers:brainstorming',
    });
  });

  it('still refuses a word that is shaped like a command but nobody owns', () => {
    expect(routeSlash('/nonsense', [cmd('review')])).toEqual({ kind: 'unknown', name: 'nonsense' });
  });

  it('leaves a message that merely mentions a path alone', () => {
    expect(routeSlash('look at /Users/david.rodriguez/a.png', [])).toEqual({ kind: 'not-a-command' });
  });

  it('does not take a code fence containing paths for a command', () => {
    expect(routeSlash('```\n/Users/david/a.ts\n```', [])).toEqual({ kind: 'not-a-command' });
  });
});
