import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // On CI the failure is annotated onto the commit itself, so which test broke and why is
  // readable without opening the log.
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
});
