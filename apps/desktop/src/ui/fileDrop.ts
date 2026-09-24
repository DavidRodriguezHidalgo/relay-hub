/**
 * Absolute paths of the images in a drop.
 *
 * The renderer cannot read a dropped file's path on its own; Electron hands it over through
 * the preload bridge, so a drop that arrives outside the app (or in a test) yields nothing.
 */
export function imagePathsFrom(dataTransfer: DataTransfer | null | undefined): string[] {
  const resolve = window.relay?.pathForFile;
  if (!resolve || !dataTransfer) return [];
  return Array.from(dataTransfer.files ?? [])
    .filter((f) => f.type.startsWith('image/'))
    .map((f) => resolve(f))
    .filter((p) => p.length > 0);
}

/** Puts dropped paths on their own lines, so the session can be asked to look at them. */
export function withPaths(text: string, paths: string[]): string {
  if (paths.length === 0) return text;
  const head = text.trimEnd();
  return `${head ? `${head}\n` : ''}${paths.join('\n')}\n`;
}
