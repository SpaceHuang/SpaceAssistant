import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { grepExecutor } from './builtinExecutors'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import type { ToolExecutionContext } from './types'

// 让 spawn('rg') 走 error 事件，强制 grepExecutor 落到 grepFallbackJs（Obs 8 分发链路）
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return {
    ...actual,
    spawn: (cmd: string, args: readonly unknown[], opts: unknown) => {
      if (cmd === 'rg') {
        const handlers: Record<string, (arg?: unknown) => void> = {}
        const proc = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: (ev: string, cb: (arg?: unknown) => void) => {
            handlers[ev] = cb
          },
          kill: vi.fn()
        }
        setImmediate(() => handlers.error?.(new Error('ENOENT')))
        return proc
      }
      return actual.spawn(cmd, args, opts)
    }
  }
})

function makeCtx(workDir: string): ToolExecutionContext {
  return {
    workDir,
    userDataDir: path.join(workDir, '.userdata'),
    requestId: 'req-test',
    toolUseId: 'tool-test',
    sessionId: 'session-test',
    sendProgress: vi.fn(),
    signal: AbortSignal.timeout(30_000),
    fileStateCache: new FileStateCache(),
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false }
  }
}

describe('grepExecutor 分发链路（rg 失败 → fallback）', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-grep-dispatch-')))
    await fs.mkdir(path.join(tmpDir, 'docs'))
    await fs.writeFile(
      path.join(tmpDir, 'docs', 'tech-design.md'),
      ['# Title', '', '## Alpha', 'some usage line', '', '### Beta', 'checkpoint here'].join('\n'),
      'utf8'
    )
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('rg 不可用时走 fallback，且透传 context 给 fallback', async () => {
    const res = await grepExecutor.execute(
      { pattern: 'some usage', path: 'docs/tech-design.md', output_mode: 'content', context: 1 },
      makeCtx(tmpDir)
    )
    expect(res.success).toBe(true)
    const out = String(res.data?.output)
    expect(out).toContain('## Alpha')
    expect(out).toContain('some usage line')
    expect(out).not.toBe('No matches found')
  })

  it('绝对路径为指向工作区外的目录联接点时拒绝（junction 越界修复）', async (ctx) => {
    const symDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-grep-junction-')))
    const outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-grep-outside-')))
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'outside secret', 'utf8')
    const link = path.join(symDir, 'evil-link')
    let created = false
    try {
      // Windows 目录联接点（junction）无需开发者模式/管理员权限；非 Windows 退化为目录 symlink
      await fs.symlink(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir')
      created = true
    } catch {
      created = false
    }
    if (!created) {
      ctx.skip()
      await fs.rm(outsideDir, { recursive: true, force: true })
      await fs.rm(symDir, { recursive: true, force: true })
      return
    }
    try {
      const res = await grepExecutor.execute(
        { pattern: 'outside secret', path: link, output_mode: 'content' },
        makeCtx(symDir)
      )
      expect(res.success).toBe(false)
      expect(res.error).toMatch(/超出|范围/)
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
      await fs.rm(symDir, { recursive: true, force: true })
    }
  })
})
