import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  // Node-based unit tests under tests/unit/ use *.test.mts and run via `pnpm test:unit`.
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  // One retry in CI only: docker rate limits and runner flakes dominate the
  // E2E failure history; deterministic failures still fail after the retry.
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 2,
  reporter: 'list',
  use: {
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off'
  }
})
