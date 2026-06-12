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
    outDir: 'dist/renderer',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        'floating-notification': path.resolve(__dirname, 'floating-notification.html')
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: true
  }
})
