import { describe, expect, it } from 'vitest';
import { matchCommands, slashQuery } from './SlashMenu';
import type { Invocable } from '@relay/shared';

const cmd = (name: string, description = ''): Invocable => ({ name, description, argumentHint: '' });
const all = [cmd('review'), cmd('clear'), cmd('factorial-backend'), cmd('superpowers:brainstorming'), cmd('preview')];

describe('slashQuery', () => {
  it('is what the user has typed after a slash that starts the message', () => {
    expect(slashQuery('/', 1)).toBe('');
    expect(slashQuery('/rev', 4)).toBe('rev');
    expect(slashQuery('  /rev', 6)).toBe('rev');
  });

  it('is nothing once the command is complete or the slash is not the message', () => {
    // a space ends the command name: the user is typing arguments now
    expect(slashQuery('/review 3497', 12)).toBe(null);
    expect(slashQuery('fix /review', 11)).toBe(null);
    expect(slashQuery('', 0)).toBe(null);
    expect(slashQuery('rebase', 6)).toBe(null);
  });

  it('follows the caret, not the end of the text', () => {
    expect(slashQuery('/rev and more', 4)).toBe('rev');
    expect(slashQuery('/rev', 0)).toBe(null);
  });
});

describe('matchCommands', () => {
  it('offers everything for a bare slash, in the order given', () => {
    expect(matchCommands(all, '').map((c) => c.name)).toEqual([
      'review',
      'clear',
      'factorial-backend',
      'superpowers:brainstorming',
      'preview',
    ]);
  });

  it('keeps what contains the query, ignoring case, and puts prefix matches first', () => {
    // "review" starts with it, "preview" only contains it
    expect(matchCommands(all, 'rev').map((c) => c.name)).toEqual(['review', 'preview']);
    expect(matchCommands(all, 'REV').map((c) => c.name)).toEqual(['review', 'preview']);
    expect(matchCommands(all, 'brain').map((c) => c.name)).toEqual(['superpowers:brainstorming']);
  });

  it('matches a plugin command by its own name, without its plugin prefix', () => {
    expect(matchCommands(all, 'brainstorming').map((c) => c.name)).toEqual(['superpowers:brainstorming']);
  });

  it('has nothing to offer for a query nothing matches', () => {
    expect(matchCommands(all, 'zzz')).toEqual([]);
  });
});
