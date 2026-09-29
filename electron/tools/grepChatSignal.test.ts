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

// Phase 2a(方案 §4):grep 直接感知聊天中止(方案 a:ctx 增可选 chatSignal,执行器内部合成)。
// 不依赖 cancelAllToolsForRequest 的隐式联动链(G3);不合并 toolChatLoop 侧两个独立信号变量。

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

  it('rg 路径:chatSignal abort 即返回已取消(工具级 signal 未动,无隐式联动)', async () => {
    const binary = await createSleepFixture(root)
    ripgrep.resolve.mockReturnValue({ path: binary, source: 'development', platform: process.platform, arch: process.arch })
    ripgrep.inspect.mockResolvedValue({ available: true })
    ctx.grepSpawnProcess = (_binary, rgArgs, options) => spawn(process.execPath, [binary, '--sleep', ...rgArgs], options)
    const chat = new AbortController()
    ctx.chatSignal = chat.signal
    const pending = grepExecutor.execute(input, ctx)
    setTimeout(() => chat.abort(), 30)
    const res = await pending
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('已取消')
  })

  it('降级路径共用同一合成信号:chatSignal 已中止时不产出搜索结果,结算为已取消', async () => {
    // 单文件降级搜索毫秒级完成,无法构造执行中 abort 的确定性时序;
    // 故验证「中止先于执行」:降级路径必须尊重合成信号,不把中止复活成搜索结果
    ripgrep.resolve.mockReturnValue({ path: null, source: 'development', platform: process.platform, arch: process.arch, reason: 'unsupported' })
    const chat = new AbortController()
    ctx.chatSignal = chat.signal
    chat.abort()
    const res = await grepExecutor.execute(input, ctx)
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('已取消')
    expect(String(res.error)).not.toContain('Found')
  })
})
