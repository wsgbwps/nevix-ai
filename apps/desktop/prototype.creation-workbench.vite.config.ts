import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve('src/renderer'),
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src')
    }
  },
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true
  },
  build: {
    outDir: resolve('out/prototype-creation-workbench'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('src/renderer/creation-workbench-prototype.html')
    }
  }
})
