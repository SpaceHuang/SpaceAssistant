import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 默认 reporter 会等串行项目中的测试文件结束才输出，长测试期间看起来像挂起；
    // dot reporter 持续给出用例进度，同时保持完整失败详情。
    reporter: 'dot',
    // 大量通过用例会打印重复的 runtime 警告；仅失败用例输出 console，减少终端 IO。
    silent: 'passed-only',
    projects: [
      {
        // 主进程测试：macOS threads 池并行实测更快；Windows 上 threads 易启动超时，保留 forks + 单 worker。
        test: {
          name: 'electron',
          // SDK 包级测试(A3)：纯 Node，与 Electron 项目共用 worker 配置。
          include: ['electron/**/*.test.ts', 'packages/agent-sdk/**/*.test.ts', 'packages/agent-provider-testing/**/*.test.ts', 'packages/agent-provider-pi-ai/**/*.test.ts'],
          environment: 'node',
          // Windows 慢机满载下 5s 默认值会误杀重 IO 用例（如 1000 并发台账写盘）；断言本身不受影响
          testTimeout: 15_000,
          globals: true,
          pool: process.platform === 'darwin' ? 'threads' : 'forks',
          maxWorkers: process.platform === 'darwin' ? 4 : 1,
          fileParallelism: process.platform === 'darwin',
          // electron 项目专属第二 setup:脚本安全解析服务初始化(§2.3 归属约束)+ 默认 runtime 装配(batch3)
          setupFiles: ['./src/test/setup.ts', './src/test/setup-electron-parser.ts', './electron/testSetup.ts']
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
      '@': path.resolve(import.meta.dirname, './src'),
      '@spaceassistant/agent-provider-pi-ai': path.resolve(import.meta.dirname, './packages/agent-provider-pi-ai/src/index.ts')
    }
  }
})
