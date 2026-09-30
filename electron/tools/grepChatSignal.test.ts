import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

const ripgrep = vi.hoisted(() => ({
  inspect: vi.fn(),
  resolve: vi.fn()
}))

vi.mock('./ripgrepBinary', async (importActual) => {
  const actual = await importActual<typeof import('./ripgrepBinary')>()
  return {
    ...actual,
    inspectRipgrepBinary: ripgrep.inspect,
    resolveRipgrepBinary: ripgrep.resolve
  }
})

import { FileStateCache } from '../fileStateCache'
import { buildReadExecutionPermit } from '../confirmation/readExecutionPermit'
import type { ToolExecutionContext } from './types'
import { grepExecutor } from './builtinExecutors'

// Hosted Runtime 将当前 turn 的 AbortSignal 作为工具执行上下文 signal，grep 直接消费该 signal。

async function makeTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-grep-chat-signal-'))
  await fs.writeFile(path.join(root, 'a.txt'), 'Needle in a\n', 'utf8')
  return root
}

async function rmRoot(root: string): Promise<void> {
  for (let i = 0; i < 24; i++) {
    try {
      await fs.rm(root, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

async function createSleepFixture(root: string): Promise<string> {
  const fixture = path.join(root, 'sleep-fixture.cjs')
  await fs.writeFile(fixture, `
if (process.argv.includes('--sleep')) {
  process.stdin.resume()
  process.stdin.on('end', () => process.exit(0))
  setTimeout(() => {}, 30000)
} else {
  process.stdout.write('hit:1:Needle\\n')
}
`, 'utf8')
  return fixture
}

describe('Phase 2a:grep 直接感知聊天中止', () => {
  let root = ''
  let cache: FileStateCache
  let ctx: ToolExecutionContext
  let file = ''
  let input: Record<string, unknown>

  beforeEach(async () => {
    root = await fs.realpath(await makeTree())
    cache = new FileStateCache()
    ctx = {
      workDir: root,
      userDataDir: path.join(root, '.userdata'),
      requestId: 'req-test',
      toolUseId: 'tool-test',
      sessionId: 'session-test',
      sendProgress: vi.fn(),
      signal: new AbortController().signal,
      fileStateCache: cache,
      toolsConfig: { ...({ grepTimeoutSec: 30 } as ToolExecutionContext['toolsConfig']) }
    }
    file = path.join(root, 'a.txt')
    input = { pattern: 'Needle', path: file }
    const stat = await fs.stat(file)
    ctx.readExecutionPermit = buildReadExecutionPermit({
      requestId: ctx.requestId!,
      toolUseId: ctx.toolUseId!,
      toolName: 'grep',
      input,
      facts: [{
        factId: 'grep-fact',
        decisionRuleId: 'read-group-workdir-allow',
        normalizedPath: file,
        zone: 'workdir-normal',
        targetKind: 'file',
        identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs }
      }]
    })
  })

  afterEach(async () => {
    await rmRoot(root)
    ripgrep.resolve.mockReset()
    ripgrep.inspect.mockReset()
  })

  it('运行中的 Hosted turn abort 会终止 rg 并返回已取消', async () => {
    const binary = await createSleepFixture(root)
    ripgrep.resolve.mockReturnValue({ path: binary, source: 'development', platform: process.platform, arch: process.arch })
    ripgrep.inspect.mockResolvedValue({ available: true })
    ctx.grepSpawnProcess = (_binary, rgArgs, options) => spawn(process.execPath, [binary, '--sleep', ...rgArgs], options)
    const turn = new AbortController()
    ctx.signal = turn.signal
    const pending = grepExecutor.execute(input, ctx)
    setTimeout(() => turn.abort(), 30)
    const res = await pending
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('已取消')
  })

  it('已取消的 Hosted turn 不启动 rg 子进程', async () => {
    const binary = await createSleepFixture(root)
    ripgrep.resolve.mockReturnValue({ path: binary, source: 'development', platform: process.platform, arch: process.arch })
    ripgrep.inspect.mockResolvedValue({ available: true })
    const turn = new AbortController()
    turn.abort()
    ctx.signal = turn.signal
    ctx.grepSpawnProcess = vi.fn()
    const res = await grepExecutor.execute(input, ctx)
    expect(res.success).toBe(false)
    expect(ctx.grepSpawnProcess).not.toHaveBeenCalled()
  })
})
