// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { workspacePackages } from '../workspace-packages';
import rendererConfig from '../vite.renderer.config';

describe('renderer dev server and the workspace packages', () => {
  it('lists every @relay package the app depends on', () => {
    expect(workspacePackages(resolve(__dirname, '..')).sort()).toEqual(['@relay/engine', '@relay/shared']);
  });

  it('serves them from source rather than a pre-bundled cache, so a new export is never missing', () => {
    // a stale pre-bundle of @relay/shared once left the whole window blank; this keeps it excluded
    const config = rendererConfig as { optimizeDeps?: { exclude?: string[] } };
    for (const name of workspacePackages(resolve(__dirname, '..'))) {
      expect(config.optimizeDeps?.exclude).toContain(name);
    }
  });
});
