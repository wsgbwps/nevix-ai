import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  // Node-based unit tests under tests/unit/ use *.test.mts and run via `pnpm test:unit`.
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    screenshot: 'off',
    trace: 'off',
    video: 'off'
  }
})
