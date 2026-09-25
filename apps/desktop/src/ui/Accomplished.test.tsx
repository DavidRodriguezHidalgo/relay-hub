import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Accomplished as Work } from '@relay/shared';
import { Accomplished } from './Accomplished';

const base: Work = { commits: [], files: [], moreFiles: 0, base: 'main', open: [], note: null };

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
    expect(screen.getByText(/5 files touched/)).toBeInTheDocument();
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
