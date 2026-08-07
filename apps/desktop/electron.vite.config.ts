import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { inspectorServer } from '@react-dev-inspector/vite-plugin'
import { loadEnv, type Plugin } from 'vite'
import {
  parseSupabasePublicConfig,
  supabasePublicConfigPolicyForMode,
  type SupabasePublicConfig
} from './src/shared/config/supabase-public-config'
import {
  parseServerPublicConfig,
  serverPublicConfigPolicyForMode,
  type ServerPublicConfig
} from './src/shared/config/server-public-config'

const CSP_CONNECT_SOURCE = '__NEVIX_CONNECT_SOURCE__'

function publicApiCspPlugin(
  supabaseConfig: SupabasePublicConfig | undefined,
  serverConfig: ServerPublicConfig | undefined,
  devInspector: boolean
): Plugin {
  // dev-only: allow same-origin requests for the react-dev-inspector launch-editor endpoint
  const connectSource = [
    supabaseConfig?.url,
    serverConfig?.url,
    ...(devInspector ? ["'self'"] : [])
  ].filter(Boolean)
  const value = connectSource.length > 0 ? connectSource.join(' ') : "'none'"

  return {
    name: 'nevix-public-api-csp',
    transformIndexHtml(html) {
      return html.replace(CSP_CONNECT_SOURCE, value)
    }
  }
}

export default defineConfig(({ mode, command }) => {
  const devInspector = command === 'serve'
  const fileEnvironment = loadEnv(mode, process.cwd(), '')
  const configuredUrl = process.env.VITE_SUPABASE_URL ?? fileEnvironment.VITE_SUPABASE_URL
  const configuredKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? fileEnvironment.VITE_SUPABASE_PUBLISHABLE_KEY
  const configuredServerUrl = process.env.VITE_SERVER_URL ?? fileEnvironment.VITE_SERVER_URL
  const supabaseConfigPolicy = supabasePublicConfigPolicyForMode(mode)
  const publicConfig = parseSupabasePublicConfig({
    url: configuredUrl,
    publishableKey: configuredKey,
    policy: supabaseConfigPolicy
  })
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
        __NEVIX_SUPABASE_URL__: JSON.stringify(configuredUrl),
        __NEVIX_SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(configuredKey),
        __NEVIX_SUPABASE_CONFIG_POLICY__: JSON.stringify(supabaseConfigPolicy),
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
        publicApiCspPlugin(publicConfig, serverConfig, devInspector)
      ]
    }
  }
})
