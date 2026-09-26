/** The one thing a window needs to offer here, so the retry can be exercised without Electron. */
export interface LoadTarget {
  loadURL(url: string): Promise<unknown>;
}

export interface RetryOptions {
  /** How many times to try before giving up. */
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Loads the development server, trying again until it answers.
 *
 * Forge launches Electron a second after starting Vite, which is often before Vite is listening.
 * A single failed load leaves the window blank for good — Electron does not retry on its own —
 * so this keeps asking for a while and only then gives up.
 *
 * @returns how many attempts it took.
 */
export async function loadWhenServing(target: LoadTarget, url: string, opts: RetryOptions = {}): Promise<number> {
  const attempts = opts.attempts ?? 60;
  const delayMs = opts.delayMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await target.loadURL(url);
      return attempt;
    } catch (err: unknown) {
      lastError = err;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw new Error(
    `The development server at ${url} did not answer after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
