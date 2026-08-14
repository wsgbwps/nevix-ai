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
      define: {
        __NEVIX_SUPABASE_URL__: JSON.stringify('https://component-test.supabase.co'),
        __NEVIX_SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(
          'sb_publishable_component_test_key_1234567890'
        ),
        __NEVIX_SUPABASE_CONFIG_POLICY__: JSON.stringify('https-only'),
        __NEVIX_SERVER_URL__: JSON.stringify('https://component-test-server.example'),
        __NEVIX_SERVER_CONFIG_POLICY__: JSON.stringify('https-only')
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
