import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Accomplished as Work } from '@relay/shared';
import { Accomplished } from './Accomplished';

const base: Work = { commits: [], files: [], moreFiles: 0, moreCommits: 0, base: 'main', open: [], note: null };

describe('Accomplished', () => {
  it('lists the commits made, newest first as given', () => {
    render(<Accomplished work={{ ...base, commits: [
      { sha: 'bbbbbbbbbb', subject: 'second', at: '2026-09-25T10:00:00.000Z' },
      { sha: 'aaaaaaaaaa', subject: 'first', at: '2026-09-25T09:00:00.000Z' },
    ] }} />);
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('second');
    expect(items[1]).toContain('first');
    expect(screen.getByText('bbbbbbb')).toBeInTheDocument();
  });

  it('counts the files touched and names them, saying how many more there were', () => {
    render(<Accomplished work={{ ...base, files: ['src/a.ts', 'src/b.ts'], moreFiles: 3 }} />);
    expect(screen.getByText(/5 files written by this session/)).toBeInTheDocument();
    expect(screen.getByText(/src\/a\.ts, src\/b\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/and 3 more/)).toBeInTheDocument();
  });

  it('lists what is still open', () => {
    render(<Accomplished work={{ ...base, open: ['1 approval waiting on you', '2 instructions never answered'] }} />);
    expect(screen.getByText('1 approval waiting on you')).toBeInTheDocument();
    expect(screen.getByText('2 instructions never answered')).toBeInTheDocument();
  });

  it('says plainly when nothing has been produced yet', () => {
    render(<Accomplished work={base} />);
    expect(screen.getByText(/nothing committed or changed/i)).toBeInTheDocument();
  });

  it('prefers the reason when there is one', () => {
    render(<Accomplished work={{ ...base, note: 'This directory is not a git repository.' }} />);
    expect(screen.getByText(/not a git repository/)).toBeInTheDocument();
  });

  it('shows nothing before it has been read', () => {
    const { container } = render(<Accomplished work={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Accomplished attribution', () => {
  const work = (over: Partial<Work>): Work => ({
    commits: [], moreCommits: 0, files: [], moreFiles: 0, base: 'main', open: [], note: null, ...over,
  });

  it('counts the commits it did not list rather than printing them all', () => {
    render(<Accomplished work={work({ commits: [{ sha: 'a1b2c3d4', subject: 'the one', at: '' }], moreCommits: 7 })} />);
    expect(screen.getByText(/and 7 more commits/)).toBeInTheDocument();
  });

  it('says the files are this session’s own, not the branch’s', () => {
    render(<Accomplished work={work({ files: ['src/a.ts'] })} />);
    expect(screen.getByText(/written by this session/)).toBeInTheDocument();
  });

  it('keeps the file list short and counts the rest', () => {
    render(<Accomplished work={work({ files: ['a.ts', 'b.ts'], moreFiles: 40 })} />);
    expect(screen.getByText(/42 files written by this session/)).toBeInTheDocument();
    expect(screen.getByText(/and 40 more/)).toBeInTheDocument();
  });

  it('says plainly when nothing here was this session’s doing', () => {
    render(<Accomplished work={work({ note: 'Nothing here was written by this session.' })} />);
    expect(screen.getByText('Nothing here was written by this session.')).toBeInTheDocument();
  });
});
