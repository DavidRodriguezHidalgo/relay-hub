import { describe, expect, it } from 'vitest';
import { downloadRelease } from '../../src/updates/download';

const bytes = (n: number) => new TextEncoder().encode('x'.repeat(n)).buffer as ArrayBuffer;

describe('downloadRelease', () => {
  const opts = {
    url: 'https://example.test/Relay-0.2.0.zip',
    name: 'Relay-0.2.0.zip',
    directory: '/downloads',
    join: (d: string, n: string) => `${d}/${n}`,
  };

  it('writes the build where the user will find it, and says where', async () => {
    const written: [string, number][] = [];
    const path = await downloadRelease({
      ...opts,
      fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes(1024) }),
      writeFile: async (p, d) => {
        written.push([p, d.byteLength]);
      },
    });
    expect(path).toBe('/downloads/Relay-0.2.0.zip');
    expect(written).toEqual([['/downloads/Relay-0.2.0.zip', 1024]]);
  });

  it('refuses a download that failed rather than leaving a broken file', async () => {
    await expect(
      downloadRelease({ ...opts, fetch: async () => ({ ok: false, status: 404, arrayBuffer: async () => bytes(0) }), writeFile: async () => undefined }),
    ).rejects.toThrow('answered 404');
  });

  it('refuses an empty download', async () => {
    await expect(
      downloadRelease({ ...opts, fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes(0) }), writeFile: async () => undefined }),
    ).rejects.toThrow('empty');
  });
});
