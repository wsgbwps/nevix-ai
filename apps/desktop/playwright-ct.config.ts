import { defineConfig } from '@playwright/experimental-ct-react'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'

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
      // ct-core injects its own @vitejs/plugin-react (v4, matched to its
      // vite 6) only while this plugins array is empty — and this repo's
      // plugin-react v5 cannot run under ct-core's vite 6. So Tailwind rides
      // along alone, and tests/tsconfig.json restores the automatic JSX
      // runtime the dropped react plugin used to provide (esbuild reads it
      // per file; test sources sit outside tsconfig.web.json's scope).
      // Tailwind compiles only for spec graphs that actually import a CSS
      // entry (the real-shell story does); CSS-less specs are unaffected.
      plugins: [tailwindcss()],
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
