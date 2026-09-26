import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrubEvent, type ScrubbableEvent } from '@relay/shared';

/**
 * Where crash reports go.
 *
 * A DSN is write-only by design — it can post a report and read nothing back — so it is safe in
 * a public repository. `RELAY_SENTRY_DSN` overrides it for anyone pointing their own copy of
 * Relay somewhere else.
 */
export const DEFAULT_DSN =
  'https://aDapYfyLzemjNzk4ATzuyEMW@s2775743.us-west-2a.betterstackdata.com/2775743';

/** Reading and writing the choice, narrowed so a test can stand in for the file system. */
type ReadText = (path: string, encoding: 'utf8') => string;
type WriteText = (path: string, data: string) => void;

/** Whether crash reports may be sent; unset until the question has been put to the person. */
export type ReportingChoice = 'yes' | 'no' | 'unset';

const CHOICE_FILE = 'crash-reporting.json';

/**
 * Kept in its own small file rather than in the engine's database.
 *
 * Reporting has to be running before the engine starts, or the startup failures worth catching
 * would happen with nothing listening — and those are exactly the ones nobody can report by hand.
 */
export function reportingChoice(userDataDir: string, read: ReadText = readFileSync): ReportingChoice {
  try {
    const raw = JSON.parse(String(read(join(userDataDir, CHOICE_FILE), 'utf8'))) as { send?: unknown };
    if (raw.send === true) return 'yes';
    if (raw.send === false) return 'no';
    return 'unset';
  } catch {
    // never asked, or the file is unreadable: either way the question is still open
    return 'unset';
  }
}

export function setReportingChoice(userDataDir: string, send: boolean, write: WriteText = writeFileSync): void {
  if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });
  write(join(userDataDir, CHOICE_FILE), JSON.stringify({ send }, null, 2));
}

/**
 * The gate every report passes through, as Sentry's `beforeSend`.
 *
 * Returning null drops the report. Anything that survives has been through the scrubber, so a
 * report can carry the shape of a failure but not the work someone was doing when it happened.
 */
export function reportFilter(home: string, allowed: () => boolean) {
  return (event: ScrubbableEvent): ScrubbableEvent | null => (allowed() ? scrubEvent(event, home) : null);
}

/**
 * Whether a report may be sent at all.
 *
 * Two gates, and both have to open. A development run never reports: the runs that produce most
 * failures are the ones nobody is asking about — tests, hot reloads, a build half-written — and
 * they would bury the reports that matter. `RELAY_REPORT_FROM_DEV=1` opens that gate on purpose.
 */
export function mayReport(state: { packaged: boolean; choice: ReportingChoice; fromDev?: string }): boolean {
  if (!state.packaged && state.fromDev !== '1') return false;
  return state.choice === 'yes';
}

export interface ReportingOptions {
  userDataDir: string;
  home: string;
  release: string;
  /** Only an installed build reports; a checkout stays quiet unless told otherwise. */
  packaged: boolean;
  dsn?: string;
  /** Injected so the wiring can be exercised without starting the real SDK. */
  init?: (options: Record<string, unknown>) => void;
}

/**
 * Starts crash reporting, if it has been agreed to.
 *
 * @returns whether reporting is now running.
 */
export function startCrashReporting(opts: ReportingOptions): boolean {
  const allowed = () =>
    mayReport({
      packaged: opts.packaged,
      choice: reportingChoice(opts.userDataDir),
      fromDev: process.env.RELAY_REPORT_FROM_DEV,
    });
  // Decided once, before the app is ready: the SDK refuses to start later, and a native crash
  // is uploaded without passing through beforeSend, so a late gate would not hold anyway.
  if (!allowed()) return false;
  const dsn = opts.dsn ?? process.env.RELAY_SENTRY_DSN ?? DEFAULT_DSN;
  if (!dsn) return false;
  const init = opts.init ?? defaultInit;
  init({
    dsn,
    release: opts.release,
    environment: opts.packaged ? 'production' : 'development',
    // the report is the failure, not the session: nothing is attached that could carry work
    sendDefaultPii: false,
    attachStacktrace: true,
    beforeSend: reportFilter(opts.home, allowed),
    // release health would phone home on its own schedule, outside beforeSend
    autoSessionTracking: false,
    // Breadcrumbs are where the leaking happens: console lines, clicked element text and request
    // URLs all carry the work someone was doing. Their debugging value does not pay for that.
    beforeBreadcrumb: () => null,
    maxBreadcrumbs: 0,
  });
  return true;
}

/* c8 ignore start -- the real SDK, exercised by running the app rather than by a test */
function defaultInit(options: Record<string, unknown>): void {
  // required lazily so a test never loads the SDK, and so a failure here cannot stop the app
  const { init } = require('@sentry/electron/main') as { init: (o: Record<string, unknown>) => void };
  init(options);
}
/* c8 ignore stop */
