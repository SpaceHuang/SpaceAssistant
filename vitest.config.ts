import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        // 主进程测试：Windows 上 threads 池易出现 worker 启动超时，保持 forks + 单 worker
        test: {
          name: 'electron',
          include: ['electron/**/*.test.ts'],
          environment: 'node',
          globals: true,
          pool: 'forks',
          maxWorkers: 1,
          fileParallelism: false,
          setupFiles: ['./src/test/setup.ts']
        }
      },
      {
        // 渲染进程测试：纯 jsdom，可安全用 threads 池并行，显著缩短环境建立时间
        test: {
          name: 'renderer',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          globals: true,
          pool: 'threads',
          maxWorkers: 4,
          setupFiles: ['./src/test/setup.ts']
        }
      }
    ]
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
})
