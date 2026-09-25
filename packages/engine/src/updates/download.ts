/** Writes a file somewhere; the real one is node's, a test hands in its own. */
export type WriteFile = (path: string, data: Uint8Array) => Promise<void>;
export type FetchBytes = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Fetches a published build and writes it next to the user's other downloads.
 *
 * It is deliberately only a download. The app is unsigned, so it cannot install over itself:
 * what this produces is a file the user opens, which is the most that is honestly possible.
 */
export async function downloadRelease(opts: {
  url: string;
  name: string;
  directory: string;
  fetch: FetchBytes;
  writeFile: WriteFile;
  join: (dir: string, name: string) => string;
}): Promise<string> {
  const res = await opts.fetch(opts.url);
  if (!res.ok) throw new Error(`the download answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error('the download was empty');
  const path = opts.join(opts.directory, opts.name);
  await opts.writeFile(path, bytes);
  return path;
}
