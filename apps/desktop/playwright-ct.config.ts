import { defineConfig } from '@playwright/experimental-ct-react'
import { resolve } from 'node:path'

export default defineConfig({
  testDir: './tests/component',
  testMatch: '**/*.spec.tsx',
  outputDir: 'node_modules/.cache/playwright-ct-results',
  timeout: 10_000,
  expect: {
    timeout: 1_000
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    ctCacheDir: 'node_modules/.cache/playwright-ct',
    ctViteConfig: {
      build: {
        emptyOutDir: true
      },
      resolve: {
        alias: {
          '@': resolve('src/renderer/src'),
          '@renderer': resolve('src/renderer/src'),
          '@ipc/channels': resolve('src/shared/ipc/channels.ts')
        }
      }
    }
  }
})
