import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseTranscriptLines, readTranscript } from '../../src/transcript/parse-transcript';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe('readTranscript', () => {
  it('extracts session metadata from a complete transcript', async () => {
    const t = await readTranscript(fixture('basic.jsonl'));
    expect(t.sessionId).toBe('s-basic');
    expect(t.cwd).toBe('/repo/wt-a');
    expect(t.gitBranch).toBe('feat/a');
    expect(t.title).toBe('Add tests for the zero-rate case');
    expect(t.lastActivity).toBe('2026-09-20T10:01:00.000Z');
    expect(t.messageCount).toBe(4);
    expect(t.prNumber).toBe(42);
    expect(t.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(t.continuedIn).toBeNull();
  });

  it('flattens message content into blocks and keeps sidechain flags', async () => {
    const t = await readTranscript(fixture('basic.jsonl'));
    expect(t.entries.map((e) => e.uuid)).toEqual(['u1', 'a1', 'u2', 'side1', 'a2']);
    expect(t.entries[0]?.blocks).toEqual([{ kind: 'text', text: 'add tests for the zero-rate case please' }]);
    expect(t.entries[1]?.blocks).toEqual([
      { kind: 'thinking' },
      { kind: 'text', text: 'Looking at the tests.' },
      { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/wt-a/a.ts' } },
    ]);
    expect(t.entries[2]?.blocks).toEqual([
      { kind: 'tool_result', toolUseId: 't1', text: 'export const a = 1;', isError: false },
    ]);
    expect(t.entries[3]?.isSidechain).toBe(true);
  });

  it('prefers the custom title and skips a truncated last line', async () => {
    const t = await readTranscript(fixture('truncated.jsonl'));
    expect(t.title).toBe('My own title');
    expect(t.entries).toHaveLength(1);
    expect(t.lastActivity).toBe('2026-09-21T08:00:00.000Z');
  });

  it('falls back to an untitled session and honours relocation', async () => {
    const t = await readTranscript(fixture('no-prompt.jsonl'));
    expect(t.title).toBe('Untitled session');
    expect(t.cwd).toBe('/repo/wt-c-moved');
    expect(t.entries[0]?.isMeta).toBe(true);
  });

  it('derives the title from the first human prompt, trimmed to 80 chars', () => {
    const long = 'x'.repeat(100);
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u', isSidechain: false, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/c', sessionId: 's', message: { role: 'user', content: long } }),
    ];
    const t = parseTranscriptLines(lines);
    expect(t.title).toBe('x'.repeat(80));
  });

  it("can summarise without materialising entries", async () => {
    const t = await readTranscript(fixture("basic.jsonl"), { entries: false });
    expect(t.entries).toEqual([]);
    expect(t.messageCount).toBe(4);
    expect(t.title).toBe("Add tests for the zero-rate case");
    expect(t.lastActivity).toBe("2026-09-20T10:01:00.000Z");
  });

  it("titles a session from a first prompt sent as blocks (text plus a pasted image)", () => {
    const line = JSON.stringify({
      type: "user", uuid: "u", isSidechain: false, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/c", sessionId: "s",
      message: { role: "user", content: [{ type: "text", text: "Fix the layout in this screenshot" }, { type: "image" }] },
    });
    expect(parseTranscriptLines([line]).title).toBe("Fix the layout in this screenshot");
  });
});
