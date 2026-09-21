import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const devPort = Number(process.env.VITE_DEV_SERVER_PORT) || 9240

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    },
    // React 必须在渲染器、Recharts 及其依赖之间保持单一运行时实例，
    // 否则开发期依赖重新预构建后会触发 Invalid hook call。
    dedupe: ['react', 'react-dom', 'react-redux']
  },
  optimizeDeps: {
    // 统计面板首次渲染时不要再临时发现并重新预构建 Recharts，避免与已加载的
    // React 运行时形成两个模块实例。
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-redux', 'recharts']
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
