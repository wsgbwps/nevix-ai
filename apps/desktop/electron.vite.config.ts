import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { inspectorServer } from '@react-dev-inspector/vite-plugin'
import { loadEnv, type Plugin } from 'vite'
import {
  parseServerPublicConfig,
  serverPublicConfigPolicyForMode,
  type ServerPublicConfig
} from './src/shared/config/server-public-config'

const CSP_CONNECT_SOURCE = '__NEVIX_CONNECT_SOURCE__'

function serverApiCspPlugin(
  serverConfig: ServerPublicConfig | undefined,
  devInspector: boolean
): Plugin {
  // dev-only: allow same-origin requests for the react-dev-inspector launch-editor endpoint
  const connectSource = [serverConfig?.url, ...(devInspector ? ["'self'"] : [])].filter(Boolean)
  const value = connectSource.length > 0 ? connectSource.join(' ') : "'none'"

  return {
    name: 'nevix-server-api-csp',
    transformIndexHtml(html) {
      return html.replace(CSP_CONNECT_SOURCE, value)
    }
  }
}

export default defineConfig(({ mode, command }) => {
  const devInspector = command === 'serve'
  const fileEnvironment = loadEnv(mode, process.cwd(), '')
  const configuredServerUrl = process.env.VITE_SERVER_URL ?? fileEnvironment.VITE_SERVER_URL
  const serverConfigPolicy = serverPublicConfigPolicyForMode(mode)
  const serverConfig = parseServerPublicConfig({
    url: configuredServerUrl,
    policy: serverConfigPolicy
  })

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
      define: {
        __NEVIX_SERVER_URL__: JSON.stringify(configuredServerUrl),
        __NEVIX_SERVER_CONFIG_POLICY__: JSON.stringify(serverConfigPolicy)
      },
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
        tailwindcss(),
        serverApiCspPlugin(serverConfig, devInspector)
      ]
    }
  }
})
