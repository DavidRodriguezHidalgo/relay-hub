import { describe, expect, it } from 'vitest';
import { scrubText, scrubEvent } from '@relay/shared';

const HOME = '/Users/david.rodriguez';

describe('scrubText', () => {
  it('takes the home directory out of a path', () => {
    expect(scrubText('cannot read /Users/david.rodriguez/notes.txt', HOME)).toBe('cannot read ~/notes.txt');
  });

  it('removes a working directory, which names the project being worked on', () => {
    expect(scrubText('Could not start a session in /Users/david.rodriguez/code/factorial-agent: EACCES', HOME))
      .toBe('Could not start a session in ~/<path>: EACCES');
  });

  it('removes another user’s home as well, not just this one', () => {
    expect(scrubText('/Users/someone.else/code/secret-thing/a.ts failed', HOME)).toBe('~/<path> failed');
  });

  it('redacts quoted text, because a session or todo title is a prompt', () => {
    expect(scrubText('"Create mileages in expenses skill" already has a session.', HOME))
      .toBe('"<redacted>" already has a session.');
  });

  it('keeps the shape of the message, so the failure is still recognisable', () => {
    expect(scrubText('No todo 8f3c-41ab.', HOME)).toBe('No todo 8f3c-41ab.');
  });

  it('leaves a message with nothing private untouched', () => {
    expect(scrubText('ENOENT: no such file or directory', HOME)).toBe('ENOENT: no such file or directory');
  });

  it('survives an empty or missing home directory rather than mangling the text', () => {
    expect(scrubText('plain message', '')).toBe('plain message');
  });
});

describe('scrubEvent', () => {
  it('cleans the exception message and the breadcrumbs', () => {
    const event = scrubEvent(
      {
        exception: { values: [{ type: 'Error', value: 'failed in /Users/david.rodriguez/code/relay-hub' }] },
        breadcrumbs: [{ message: 'opened "Create mileages in expenses skill"' }],
      },
      HOME,
    );
    expect(event.exception?.values?.[0]?.value).toBe('failed in ~/<path>');
    expect(event.breadcrumbs?.[0]?.message).toBe('opened "<redacted>"');
  });

  it('drops extra data wholesale, since we cannot know what was put there', () => {
    const event = scrubEvent({ extra: { cwd: '/Users/david.rodriguez/code/x', branch: 'feat/secret' } }, HOME);
    expect(event.extra).toBeUndefined();
  });

  it('drops the username and any server name the machine carries', () => {
    const event = scrubEvent({ user: { username: 'david.rodriguez', ip_address: '10.0.0.2' }, server_name: 'Davids-MacBook' }, HOME);
    expect(event.user).toBeUndefined();
    expect(event.server_name).toBeUndefined();
  });

  it('keeps what makes the report useful: the type and the stack', () => {
    const event = scrubEvent(
      { exception: { values: [{ type: 'TypeError', value: 'x is not a function', stacktrace: { frames: [{ filename: 'app:///main.js', lineno: 42 }] } }] } },
      HOME,
    );
    expect(event.exception?.values?.[0]?.type).toBe('TypeError');
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]).toMatchObject({ filename: 'app:///main.js', lineno: 42 });
  });

  it('cleans a stack frame that still points at a real directory', () => {
    const event = scrubEvent(
      { exception: { values: [{ stacktrace: { frames: [{ filename: '/Users/david.rodriguez/code/relay-hub/apps/desktop/src/main.ts' }] } }] } },
      HOME,
    );
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe('~/<path>');
  });
});
