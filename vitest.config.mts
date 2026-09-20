import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        // 主进程测试：Windows 上 threads 池易出现 worker 启动超时，保持 forks + 单 worker
        test: {
          name: 'electron',
          // SDK 包级测试(A3):纯 node,随 electron 项目 forks 单 worker 跑
          include: ['electron/**/*.test.ts', 'packages/agent-core/**/*.test.ts'],
          environment: 'node',
          // Windows 慢机满载下 5s 默认值会误杀重 IO 用例（如 1000 并发台账写盘）；断言本身不受影响
          testTimeout: 15_000,
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
          // 同上：jsdom 组件交互用例在满载下 5s 不够（性能界限类用例自行断言更紧的界）
          testTimeout: 15_000,
          exclude: ['src/**/*.perf.*.test.tsx', '**/node_modules/**'],
          environment: 'jsdom',
          globals: true,
          pool: 'threads',
          maxWorkers: 4,
          setupFiles: ['./src/test/setup.ts']
        }
      },
      {
        // 性能采集测试：保留 jsdom/mock 生命周期，但不进入默认回归测试集
        test: {
          name: 'renderer-perf',
          include: ['src/**/*.perf.*.test.tsx'],
          environment: 'jsdom',
          globals: true,
          pool: 'threads',
          maxWorkers: 1,
          setupFiles: ['./src/test/setup.ts']
        }
      }
    ]
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src')
    }
  }
})
