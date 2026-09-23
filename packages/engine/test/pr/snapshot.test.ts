import { describe, expect, it } from 'vitest';
import type { PrData } from '../../src/pr/gh-client';
import { diffSnapshots, toSnapshot } from '../../src/pr/snapshot';

const pr = (over: Partial<PrData> = {}): PrData => ({
  number: 7, url: 'https://github.com/o/r/pull/7', title: 'Mileage', state: 'OPEN',
  headRefName: 'feat/m', headRefOid: 'h1', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  checks: [{ name: 'lint', conclusion: 'SUCCESS', status: 'COMPLETED' }], feedback: [], ...over,
});
const diff = (a: PrData, b: PrData, viewer = 'me') => diffSnapshots(toSnapshot(a), toSnapshot(b), b, viewer);
const kinds = (a: PrData, b: PrData, viewer?: string) => diff(a, b, viewer).map((e) => e.kind);
const failing = (...names: string[]) => names.map((name) => ({ name, conclusion: 'FAILURE', status: 'COMPLETED' }));

describe('diffSnapshots', () => {
  it('reports nothing when nothing changed', () => {
    expect(kinds(pr(), pr())).toEqual([]);
  });

  it('ci_failed once per newly failing check on the same head, not on every poll', () => {
    const a = pr();
    const b = pr({ checks: failing('test') });
    expect(kinds(a, b)).toEqual(['ci_failed']);
    expect(kinds(b, b)).toEqual([]);
    const c = pr({ checks: [...failing('test'), ...failing('e2e')] });
    const events = diff(b, c);
    expect(events.map((e) => e.kind)).toEqual(['ci_failed']);
    expect(events[0]!.details).toContain('e2e');
    expect(events[0]!.summary).toBe('CI failed on PR #7: e2e'); // only the new failure
  });

  it('a new head commit resets failures, so failing again wakes again', () => {
    const failed = pr({ checks: failing('test') });
    const pushedGreen = pr({ headRefOid: 'h2', checks: [{ name: 'test', conclusion: null, status: 'IN_PROGRESS' }] });
    const failedAgain = pr({ headRefOid: 'h2', checks: failing('test') });
    expect(kinds(failed, pushedGreen)).toEqual([]);
    expect(kinds(pushedGreen, failedAgain)).toEqual(['ci_failed']);
  });

  it('counts TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE and status ERROR as failing', () => {
    for (const conclusion of ['TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR', 'FAILURE']) {
      expect(kinds(pr(), pr({ checks: [{ name: 'x', conclusion, status: 'COMPLETED' }] }))).toEqual(['ci_failed']);
    }
    expect(kinds(pr(), pr({ checks: [{ name: 'x', conclusion: 'SKIPPED', status: 'COMPLETED' }] }))).toEqual([]);
  });

  it('review_comment for new feedback from others, never from the viewer or bots', () => {
    const at = (m: number) => `2026-09-23T10:0${m}:00Z`;
    const base = pr({ feedback: [{ id: 'old', author: 'ana', body: 'old', at: at(0) }] });
    const mine = pr({ feedback: [...base.feedback, { id: 'm', author: 'me', body: 'I replied', at: at(1) }] });
    expect(kinds(base, mine)).toEqual([]);
    const bots = pr({
      feedback: [
        ...base.feedback,
        { id: 'b1', author: 'github-actions', body: 'coverage', at: at(2) },
        { id: 'b2', author: 'mergify[bot]', body: 'queued', at: at(3) },
      ],
    });
    expect(kinds(base, bots)).toEqual([]);
    const review = pr({ feedback: [...base.feedback, { id: 'r', author: 'bob', body: 'Please rename x', at: at(4) }] });
    const events = diff(base, review);
    expect(events.map((e) => e.kind)).toEqual(['review_comment']);
    expect(events[0]!.details).toContain('bob');
    expect(events[0]!.details).toContain('Please rename x');
  });

  it('base_moved only when the PR becomes conflicting or behind', () => {
    expect(kinds(pr(), pr({ mergeable: 'CONFLICTING' }))).toEqual(['base_moved']);
    expect(kinds(pr(), pr({ mergeStateStatus: 'BEHIND' }))).toEqual(['base_moved']);
    expect(kinds(pr({ mergeable: 'CONFLICTING' }), pr({ mergeable: 'CONFLICTING' }))).toEqual([]);
    expect(kinds(pr({ mergeable: 'UNKNOWN' }), pr({ mergeable: 'MERGEABLE' }))).toEqual([]);
  });

  it('merged when the state becomes MERGED; nothing else is reported with it', () => {
    expect(kinds(pr(), pr({ state: 'MERGED', checks: failing('late') }))).toEqual(['merged']);
  });
});
