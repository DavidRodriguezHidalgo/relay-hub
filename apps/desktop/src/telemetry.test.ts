// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DSN, mayReport, reportFilter, reportingChoice, setReportingChoice, startCrashReporting } from './telemetry';

const HOME = '/Users/david.rodriguez';
const reads = (content: string) => (_path: string, _encoding: 'utf8') => content;
const missing = (_path: string, _encoding: 'utf8'): string => {
  throw new Error('ENOENT');
};

describe('reportingChoice', () => {
  it('is unset until the question has been put', () => {
    expect(reportingChoice('/data', missing)).toBe('unset');
  });

  it('remembers a yes and a no', () => {
    expect(reportingChoice('/data', reads('{"send":true}'))).toBe('yes');
    expect(reportingChoice('/data', reads('{"send":false}'))).toBe('no');
  });

  it('treats a damaged file as never having been asked, rather than as consent', () => {
    expect(reportingChoice('/data', reads('not json'))).toBe('unset');
    expect(reportingChoice('/data', reads('{}'))).toBe('unset');
  });
});

describe('reportFilter', () => {
  it('drops everything while reporting is not allowed', () => {
    const filter = reportFilter(HOME, () => false);
    expect(filter({ message: 'anything' })).toBeNull();
  });

  it('cleans what it lets through', () => {
    const filter = reportFilter(HOME, () => true);
    const event = filter({
      message: 'failed in /Users/david.rodriguez/code/factorial-agent',
      extra: { branch: 'feat/secret' },
    });
    expect(event?.message).toBe('failed in ~/<path>');
    expect(event?.extra).toBeUndefined();
  });

  it('asks again on every report, so turning it off stops the next one', () => {
    let on = true;
    const filter = reportFilter(HOME, () => on);
    expect(filter({ message: 'one' })).not.toBeNull();
    on = false;
    expect(filter({ message: 'two' })).toBeNull();
  });
});

describe('mayReport', () => {
  it('stays quiet in a checkout, which is where my own test runs live', () => {
    expect(mayReport({ packaged: false, choice: 'yes' })).toBe(false);
  });

  it('opens for a checkout only when someone asks for it on purpose', () => {
    expect(mayReport({ packaged: false, choice: 'yes', fromDev: '1' })).toBe(true);
    expect(mayReport({ packaged: false, choice: 'no', fromDev: '1' })).toBe(false);
  });

  it('needs an answered yes even from an installed build', () => {
    expect(mayReport({ packaged: true, choice: 'unset' })).toBe(false);
    expect(mayReport({ packaged: true, choice: 'no' })).toBe(false);
    expect(mayReport({ packaged: true, choice: 'yes' })).toBe(true);
  });
});

describe('startCrashReporting', () => {
  const opts = { userDataDir: '/data', home: HOME, release: 'relay@0.1.0', packaged: true };

  it('does not start while the question is unanswered', () => {
    const init = vi.fn();
    expect(startCrashReporting({ ...opts, init, userDataDir: '/nope' })).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('sends no breadcrumbs, which is where console lines and clicks would leak', () => {
    const dir = `/tmp/relay-telemetry-crumbs-${Date.now()}`;
    setReportingChoice(dir, true);
    const init = vi.fn();
    startCrashReporting({ ...opts, userDataDir: dir, init });
    const passed = init.mock.calls[0]?.[0] as { beforeBreadcrumb: () => unknown; maxBreadcrumbs: number };
    expect(passed.beforeBreadcrumb()).toBeNull();
    expect(passed.maxBreadcrumbs).toBe(0);
  });

  it('reports to Better Stack, tagged with the build, once agreed', () => {
    const dir = `/tmp/relay-telemetry-${Date.now()}`;
    setReportingChoice(dir, true);
    const init = vi.fn();
    expect(startCrashReporting({ ...opts, userDataDir: dir, init })).toBe(true);
    const passed = init.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed.dsn).toBe(DEFAULT_DSN);
    expect(String(passed.dsn)).toContain('betterstackdata.com');
    expect(passed.release).toBe('relay@0.1.0');
    expect(passed.sendDefaultPii).toBe(false);
  });

  it('never starts from a checkout, however the choice was answered', () => {
    const dir = `/tmp/relay-telemetry-dev-${Date.now()}`;
    setReportingChoice(dir, true);
    const init = vi.fn();
    expect(startCrashReporting({ ...opts, userDataDir: dir, packaged: false, init })).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('does not let release health phone home outside the gate', () => {
    const dir = `/tmp/relay-telemetry-health-${Date.now()}`;
    setReportingChoice(dir, true);
    const init = vi.fn();
    startCrashReporting({ ...opts, userDataDir: dir, init });
    expect((init.mock.calls[0]?.[0] as { autoSessionTracking: boolean }).autoSessionTracking).toBe(false);
  });

  it('stops reporting once it is turned off again', () => {
    const dir = `/tmp/relay-telemetry-off-${Date.now()}`;
    setReportingChoice(dir, true);
    expect(startCrashReporting({ ...opts, userDataDir: dir, init: vi.fn() })).toBe(true);
    setReportingChoice(dir, false);
    expect(startCrashReporting({ ...opts, userDataDir: dir, init: vi.fn() })).toBe(false);
  });
});

