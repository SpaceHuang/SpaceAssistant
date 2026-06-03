import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const devPort = Number(process.env.VITE_DEV_SERVER_PORT) || 9240

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  build: {
    outDir: 'dist/renderer'
  },
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: true
  }
})
