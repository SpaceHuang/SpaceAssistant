import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    fileParallelism: false,
    singleFork: true,
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
