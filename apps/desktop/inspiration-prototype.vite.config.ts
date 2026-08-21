import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': resolve('src/renderer/src')
    }
  },
  server: {
    host: '127.0.0.1',
    port: 4174
  },
  build: {
    outDir: 'node_modules/.cache/inspiration-prototype-build',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('inspiration-prototype.html')
    }
  }
})
