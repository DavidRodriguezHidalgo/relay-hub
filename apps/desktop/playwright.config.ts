import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // Every test here launches a whole Electron app. Several starting at once on a CI runner
  // contend for the same unpacked binary and fail to spawn at all ("Process failed to launch",
  // "Electron failed to install correctly", kill EPERM) — a failure that says nothing about the
  // code. One at a time costs a few seconds against a job already dominated by packaging.
  workers: process.env.CI ? 1 : undefined,
  // On CI the failure is annotated onto the commit itself, so which test broke and why is
  // readable without opening the log.
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
});
