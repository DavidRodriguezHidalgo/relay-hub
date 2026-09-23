import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RelayEngine } from '../src/relay-engine';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('RelayEngine', () => {
  let root: string;
  let engine: RelayEngine | null = null;
  afterEach(async () => {
    await engine?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('starts with an initial scan and serves transcripts', async () => {
    root = await mkdtemp(join(tmpdir(), 'relay-engine-'));
    await mkdir(join(root, 'projects', 'p'), { recursive: true });
    await copyFile(fixture('no-prompt.jsonl'), join(root, 'projects', 'p', 's-noprompt.jsonl'));
    engine = await RelayEngine.start({
      projectsDir: join(root, 'projects'),
      dbPath: join(root, 'relay.db'),
      git: { inspect: async () => ({ branch: null, repo: null }) },
    });
    expect(engine.listSessions().map((s) => s.id)).toEqual(['s-noprompt']);
    expect(await engine.getTranscript('s-noprompt')).toHaveLength(2);
  });
});
