import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Windows 上 threads 池易出现 worker 启动超时；forks 更稳定
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}', 'electron/**/*.test.ts'],
    environmentMatchGlobs: [['electron/**', 'node']],
    setupFiles: ['./src/test/setup.ts']
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
})
