import type { Invocable, ModelChoice } from '@relay/shared';

/**
 * What the user is typing as a command name, or null when they are not naming one.
 *
 * A command is only a command when it opens the message, as in Claude Code itself; the
 * first space ends the name, so arguments do not keep the menu open.
 */
export function slashQuery(value: string, caret: number): string | null {
  const before = value.slice(0, caret);
  const trimmed = before.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const name = trimmed.slice(1);
  return /\s/.test(name) ? null : name;
}

/** The last segment of a plugin-qualified name, so `brainstorming` finds `superpowers:brainstorming`. */
function shortName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

/** Commands matching what has been typed: prefix matches first, each group in the order given. */
export function matchCommands(all: Invocable[], query: string): Invocable[] {
  const q = query.toLowerCase();
  if (!q) return all;
  const prefix: Invocable[] = [];
  const rest: Invocable[] = [];
  for (const c of all) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q) || shortName(name).startsWith(q)) prefix.push(c);
    else if (name.includes(q)) rest.push(c);
  }
  return [...prefix, ...rest];
}

/** Replaces the half-typed name with the chosen command, leaving the caret ready for arguments. */
export function applyCommand(value: string, caret: number, name: string): { value: string; caret: number } {
  const before = value.slice(0, caret);
  const start = before.indexOf('/');
  const head = `${value.slice(0, start)}/${name} `;
  return { value: head + value.slice(caret), caret: head.length };
}

/** Anything the menu can offer: a command to complete, or a model to switch to. */
export interface MenuItem {
  key: string;
  label: string;
  description: string;
  hint?: string;
  /** Marked as the one in use, for a list of things you choose between. */
  current?: boolean;
}

export const commandItem = (c: Invocable): MenuItem => ({
  key: c.name,
  label: `/${c.name}`,
  description: c.description,
  hint: c.argumentHint,
});

export const modelItem = (m: ModelChoice): MenuItem => ({
  key: m.id,
  label: m.name,
  description: m.description,
  current: m.current,
});

interface Props {
  items: MenuItem[];
  activeIndex: number;
  onPick: (item: MenuItem) => void;
  onHover: (index: number) => void;
}

export function SlashMenu({ items, activeIndex, onPick, onHover }: Props) {
  if (items.length === 0) return null;
  return (
    <ul className="slash-menu" role="listbox" aria-label="Commands">
      {items.map((c, i) => (
        <li
          key={c.key}
          id={`slash-option-${i}`}
          role="option"
          aria-selected={i === activeIndex}
          aria-current={c.current ? 'true' : undefined}
          className={i === activeIndex ? 'slash-menu__item slash-menu__item--active' : 'slash-menu__item'}
          onMouseEnter={() => onHover(i)}
          // mousedown, not click: the textarea must not lose focus before the pick lands
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
        >
          <span className="slash-menu__name">
            {c.label}
            {c.hint && <span className="slash-menu__hint"> {c.hint}</span>}
            {c.current && <span className="slash-menu__hint"> · in use</span>}
          </span>
          <span className="slash-menu__desc">{c.description}</span>
        </li>
      ))}
    </ul>
  );
}
