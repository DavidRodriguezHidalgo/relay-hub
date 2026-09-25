import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SessionStatus } from '@relay/shared';
import { WorkStanding } from './WorkStanding';

const base: SessionStatus = {
  branch: 'feat/a',
  lastCommit: { sha: 'abc1234def5678', subject: 'the last thing', at: '2026-09-25T09:00:00.000Z' },
  uncommitted: 0, unpushed: 0, upstream: 'origin/feat/a', pr: null, checks: null, note: null,
};

describe('WorkStanding', () => {
  it('shows the last commit and that it is pushed', () => {
    render(<WorkStanding status={base} />);
    expect(screen.getByText('abc1234')).toBeInTheDocument();
    expect(screen.getByText(/the last thing/)).toBeInTheDocument();
    expect(screen.getByText(/pushed to origin\/feat\/a/)).toBeInTheDocument();
  });

  it('calls out work that is not committed or not pushed', () => {
    render(<WorkStanding status={{ ...base, uncommitted: 3, unpushed: 2 }} />);
    expect(screen.getByText('3 uncommitted')).toBeInTheDocument();
    expect(screen.getByText('2 unpushed')).toBeInTheDocument();
  });

  it('names the checks that failed rather than only counting them', () => {
    render(<WorkStanding status={{ ...base, checks: [
      { name: 'typecheck', conclusion: 'SUCCESS' },
      { name: 'e2e', conclusion: 'FAILURE' },
      { name: 'tests', conclusion: 'IN_PROGRESS' },
    ] }} />);
    expect(screen.getByText(/1 failed: e2e/)).toBeInTheDocument();
    expect(screen.getByText(/1 still running/)).toBeInTheDocument();
  });

  it('reports a clean run as passed', () => {
    render(<WorkStanding status={{ ...base, checks: [{ name: 'tests', conclusion: 'SUCCESS' }] }} />);
    expect(screen.getByText('1 passed')).toBeInTheDocument();
  });

  it('says why there is nothing to report, since a blank reads like a pass', () => {
    render(<WorkStanding status={{ ...base, note: 'No pull request for this branch, so there are no checks to report.' }} />);
    expect(screen.getByText(/no pull request/i)).toBeInTheDocument();
  });

  it('shows nothing at all before anything has been read', () => {
    const { container } = render(<WorkStanding status={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
