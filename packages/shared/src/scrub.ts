/**
 * Takes private detail out of a crash report before it leaves the machine.
 *
 * Relay's errors are full of things that are nobody else's business: the directory a session
 * runs in names the project, a branch name names the work, and a session or todo title is a
 * prompt someone typed. None of that helps fix a bug. What helps is the kind of failure and
 * where in Relay's own code it happened, and that is what survives.
 *
 * The rules are deliberately blunt. A report that is missing context can still be debugged; one
 * that leaks a client's work cannot be taken back.
 */

/** Anything under a user's home, with enough of the tail to be recognisable as a path. */
const HOME_LIKE = /\/(?:Users|home)\/[^/\s"']+/g;
/** A path with directories in it: the directories are what name the work. */
const DEEP_PATH = /~\/[^\s"':;,)]+/g;
/** Quoted text: session titles, todo titles and branch names arrive this way. */
const QUOTED = /"[^"]*"/g;

/**
 * @param home the running user's home directory, replaced first so it is never mistaken for a
 * stranger's; an empty one is ignored rather than matching everything.
 */
export function scrubText(text: string, home: string): string {
  let out = text;
  if (home) out = out.split(home).join('~');
  out = out.replace(HOME_LIKE, '~');
  // `~/notes.txt` is harmless; `~/code/factorial-agent` names the project, so anything deeper goes
  out = out.replace(DEEP_PATH, (path) => (path.split('/').length > 2 ? '~/<path>' : path));
  return out.replace(QUOTED, '"<redacted>"');
}

/** The parts of a Sentry event this touches; kept structural so the SDK's types are not needed here. */
export interface ScrubbableEvent {
  message?: string;
  server_name?: string;
  user?: unknown;
  extra?: unknown;
  exception?: {
    values?: {
      type?: string;
      value?: string;
      stacktrace?: { frames?: { filename?: string; lineno?: number }[] };
    }[];
  };
  breadcrumbs?: { message?: string }[];
}

/**
 * Cleans an event in place of sending it as it came.
 *
 * `extra`, the user and the machine name are dropped outright: we cannot know what was put in
 * them, and a rule that has to guess is a rule that will one day guess wrong.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T, home: string): T {
  const clean = { ...event };
  delete clean.extra;
  delete clean.user;
  delete clean.server_name;
  if (typeof clean.message === 'string') clean.message = scrubText(clean.message, home);
  if (clean.exception?.values) {
    clean.exception = {
      ...clean.exception,
      values: clean.exception.values.map((value) => ({
        ...value,
        ...(typeof value.value === 'string' ? { value: scrubText(value.value, home) } : {}),
        ...(value.stacktrace?.frames
          ? {
              stacktrace: {
                ...value.stacktrace,
                frames: value.stacktrace.frames.map((frame) => ({
                  ...frame,
                  ...(typeof frame.filename === 'string' ? { filename: scrubText(frame.filename, home) } : {}),
                })),
              },
            }
          : {}),
      })),
    };
  }
  if (clean.breadcrumbs) {
    clean.breadcrumbs = clean.breadcrumbs.map((crumb) => ({
      ...crumb,
      ...(typeof crumb.message === 'string' ? { message: scrubText(crumb.message, home) } : {}),
    }));
  }
  return clean;
}
