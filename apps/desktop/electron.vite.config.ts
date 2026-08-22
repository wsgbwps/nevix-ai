import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { inspectorServer } from '@react-dev-inspector/vite-plugin'

export default defineConfig(({ command }) => {
  const devInspector = command === 'serve'

  return {
    main: {
      resolve: {
        alias: {
          '@ipc/channels': resolve('src/shared/ipc/channels.ts')
        }
      }
    },
    preload: {
      resolve: {
        alias: {
          '@ipc/channels': resolve('src/shared/ipc/channels.ts')
        }
      }
    },
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@': resolve('src/renderer/src'),
          '@ipc/channels': resolve('src/shared/ipc/channels.ts')
        }
      },
      plugins: [
        tanstackRouter({
          target: 'react',
          routesDirectory: resolve('src/renderer/src/app/routes'),
          generatedRouteTree: resolve('src/renderer/src/app/routeTree.gen.ts')
        }),
        ...(devInspector
          ? [
              inspectorServer(),
              react({ babel: { plugins: ['@react-dev-inspector/babel-plugin'] } })
            ]
          : [react()]),
        tailwindcss()
      ]
    }
  }
})
