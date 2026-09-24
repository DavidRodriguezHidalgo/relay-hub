import { visit } from 'unist-util-visit';
import type { Root, Text } from 'mdast';

/** Marks a link the app handles itself. A fragment, because other schemes are stripped as unsafe. */
export const SESSION_HREF = '#relay-session/';

/** A full session id, or the short form the orchestrator usually writes. */
const CANDIDATE = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{8}\b/g;

/** Session ids by every spelling they are referred to by; an ambiguous short form is left out. */
export function idLookup(sessions: { id: string }[]): Map<string, string> {
  const shortCount = new Map<string, number>();
  for (const s of sessions) shortCount.set(s.id.slice(0, 8), (shortCount.get(s.id.slice(0, 8)) ?? 0) + 1);
  const lookup = new Map<string, string>();
  for (const s of sessions) {
    lookup.set(s.id, s.id);
    const short = s.id.slice(0, 8);
    if (shortCount.get(short) === 1) lookup.set(short, s.id);
  }
  return lookup;
}

/**
 * Turns session ids in a reply into links the app opens.
 *
 * It walks the parsed document rather than the source, so ids inside code spans and fenced
 * blocks are left exactly as they were written. An id belonging to no known session stays text.
 */
export function remarkSessionLinks(sessions: { id: string }[]) {
  const lookup = idLookup(sessions);
  return () => (tree: Root) => {
    if (lookup.size === 0) return;
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index === null || index === undefined) return;
      const parts = splitOnIds(node.value, lookup);
      if (parts.length === 1 && parts[0]!.type === 'text') return;
      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}

type Part = Text | { type: 'link'; url: string; children: Text[] };

function splitOnIds(value: string, lookup: Map<string, string>): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const match of value.matchAll(CANDIDATE)) {
    const id = lookup.get(match[0]);
    if (!id || match.index === undefined) continue;
    if (match.index > last) parts.push({ type: 'text', value: value.slice(last, match.index) });
    parts.push({ type: 'link', url: `${SESSION_HREF}${id}`, children: [{ type: 'text', value: match[0] }] });
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return [{ type: 'text', value }];
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) });
  return parts;
}
