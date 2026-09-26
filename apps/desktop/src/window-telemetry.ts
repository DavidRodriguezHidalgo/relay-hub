import { scrubEvent } from '@relay/shared';

/**
 * Reporting for the window.
 *
 * The renderer hands its failures to the main process, which owns the DSN and the consent, so
 * nothing is sent from here that the main process would not have sent itself. Events are
 * scrubbed on this side too: a report should never depend on a single gate holding.
 */
export async function startWindowReporting(
  allowed: () => Promise<boolean> = () => window.relay.crashReports(),
  load = () => import('@sentry/electron/renderer'),
): Promise<boolean> {
  try {
    if (!(await allowed())) return false;
    const { init } = await load();
    init({ beforeSend: (event) => scrubEvent(event, ''), beforeBreadcrumb: () => null, maxBreadcrumbs: 0 });
    return true;
  } catch {
    // reporting is a convenience; a window that cannot report must still open
    return false;
  }
}
