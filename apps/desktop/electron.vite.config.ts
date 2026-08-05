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

const CSP_CONNECT_SOURCE = '__NEVIX_SUPABASE_CONNECT_SOURCE__'

function supabaseCspPlugin(
  config: SupabasePublicConfig | undefined,
  devInspector: boolean
): Plugin {
  // dev-only: allow same-origin requests for the react-dev-inspector launch-editor endpoint
  const connectSource = devInspector
    ? [config?.url, "'self'"].filter(Boolean).join(' ')
    : (config?.url ?? "'none'")

  return {
    name: 'nevix-supabase-csp',
    transformIndexHtml(html) {
      return html.replace(CSP_CONNECT_SOURCE, connectSource)
    }
  }
}

export default defineConfig(({ mode, command }) => {
  const devInspector = command === 'serve'
  const fileEnvironment = loadEnv(mode, process.cwd(), '')
  const configuredUrl = process.env.VITE_SUPABASE_URL ?? fileEnvironment.VITE_SUPABASE_URL
  const configuredKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? fileEnvironment.VITE_SUPABASE_PUBLISHABLE_KEY
  const configPolicy = supabasePublicConfigPolicyForMode(mode)
  const publicConfig = parseSupabasePublicConfig({
    url: configuredUrl,
    publishableKey: configuredKey,
    policy: configPolicy
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
        __NEVIX_SUPABASE_CONFIG_POLICY__: JSON.stringify(configPolicy)
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
        supabaseCspPlugin(publicConfig, devInspector)
      ]
    }
  }
})
