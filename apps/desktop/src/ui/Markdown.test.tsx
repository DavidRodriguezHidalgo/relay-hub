import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('shows a reply as headings, emphasis, code and lists rather than as its source', () => {
    render(<Markdown text={'## Facts\n\n**#3366** is a `draft`.\n\n- one\n- two\n'} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Facts');
    expect(screen.getByText('#3366').tagName).toBe('STRONG');
    expect(screen.getByText('draft').tagName).toBe('CODE');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps a fenced block whole', () => {
    render(<Markdown text={'```ts\nconst head = "b419ecd58";\n```'} />);
    expect(screen.getByText(/const head/).closest('pre')).toBeInTheDocument();
  });

  it('lays out a table', () => {
    render(<Markdown text={'| files | lines |\n| --- | --- |\n| 61 | +3281 |\n'} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '61' })).toBeInTheDocument();
  });

  it('sends links to the browser and never runs raw HTML', () => {
    render(<Markdown text={'[PR](https://github.com/x/y/pull/3366)\n\n<script>alert(1)</script>\n'} />);
    const link = screen.getByRole('link', { name: 'PR' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
  });
});
