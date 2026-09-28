import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'

import { classifyDirectoryError, listDirectoryExecutor, type ToolExecutionContext } from './builtinExecutors'
import { buildReadExecutionPermit, type ReadPermitTarget } from '../confirmation/readExecutionPermit'
import type { ToolExecutorResult } from './types'

function ctx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    workDir: os.tmpdir(),
    userDataDir: os.tmpdir(),
    requestId: 'r',
    toolUseId: 't',
    sessionId: 's',
    sendProgress: () => {},
    signal: new AbortController().signal,
    fileStateCache: { get: () => undefined, set: () => {}, clear: () => {} } as never,
    toolsConfig: {} as never,
    ...overrides
  }
}

/** 构造绑定真实目录 identity 的合法 list_directory permit（main 边界策略：无 permit 不执行） */
async function permitFor(workDir: string, input: Record<string, unknown>): Promise<ReadPermitTarget[]> {
  const targetRel = typeof input.path === 'string' ? input.path : '.'
  const abs = path.resolve(workDir, targetRel)
  const st = await fs.statSync(abs)
  return [
    {
      factId: `fact-${abs.toLowerCase()}`,
      decisionRuleId: 'test-rule',
      normalizedPath: abs,
      zone: 'workdir-normal',
      targetKind: 'directory',
      scope: 'direct-entries',
      identity: { dev: st.dev, ino: st.ino, mode: st.mode, size: st.size, mtimeMs: st.mtimeMs }
    }
  ]
}

describe('classifyDirectoryError（R8 四分类纯函数）', () => {
  it('ENOENT → PATH_NOT_FOUND；EACCES/EPERM → ACCESS_DENIED；ENOTDIR → NOT_A_DIRECTORY；未知 → ACCESS_DENIED（保守兜底）', () => {
    expect(classifyDirectoryError({ code: 'ENOENT' })).toBe('PATH_NOT_FOUND')
    expect(classifyDirectoryError({ code: 'EACCES' })).toBe('ACCESS_DENIED')
    expect(classifyDirectoryError({ code: 'EPERM' })).toBe('ACCESS_DENIED')
    expect(classifyDirectoryError({ code: 'ENOTDIR' })).toBe('NOT_A_DIRECTORY')
    expect(classifyDirectoryError({ code: 'EIO' })).toBe('ACCESS_DENIED')
  })

  it('abort → ABORTED（调用方映射 READ_TIMEOUT）', () => {
    const err = new Error('aborted')
    ;(err as NodeJS.ErrnoException & { name: string }).name = 'AbortError'
    expect(classifyDirectoryError(err)).toBe('ABORTED')
  })
})

describe('list_directory 在边界策略（read permit）下的可达行为', () => {
  it('合法 permit → 成功枚举直接子项（permit sanity）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ls-r8-'))
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'x')
    try {
      const input = { path: 'sub' }
      const r = (await listDirectoryExecutor.execute(
        input,
        ctx({ workDir: root, readExecutionPermit: buildReadExecutionPermit({ requestId: 'r', toolUseId: 't', toolName: 'list_directory', input, facts: await permitFor(root, input) }) })
      )) as ToolExecutorResult
      expect(r.success).toBe(true)
      expect((r.data as { entries: Array<{ name: string }> }).entries.some((e) => e.name === 'a.txt')).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('T-R8-2：abort 注入 → READ_TIMEOUT + retryable:true（文案区别于其他类目）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ls-r8-'))
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
    try {
      const ac = new AbortController()
      ac.abort()
      const input = { path: 'sub' }
      const r = (await listDirectoryExecutor.execute(
        input,
        ctx({
          workDir: root,
          signal: ac.signal,
          readExecutionPermit: buildReadExecutionPermit({ requestId: 'r', toolUseId: 't', toolName: 'list_directory', input, facts: await permitFor(root, input) })
        })
      )) as ToolExecutorResult
      expect(r.success).toBe(false)
      expect(r.error).toBe('DIRECTORY_READ_TIMEOUT')
      const data = r.data as { errorClass: string; retryable: boolean }
      expect(data.errorClass).toBe('READ_TIMEOUT')
      expect(data.retryable).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('无 permit → read-permit-missing 拒绝（边界策略前置，R8 分类在 permit identity 校验后的窄窗口才可达）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ls-r8-'))
    fs.mkdirSync(path.join(root, 'gone'), { recursive: true })
    try {
      const r = (await listDirectoryExecutor.execute(
        { path: 'gone' },
        ctx({ workDir: root })
      )) as ToolExecutorResult
      expect(r.success).toBe(false)
      expect(r.error).toBe('目录读取许可校验失败')
      expect((r.diagnostic as { caseId: string }).caseId).toBe('read-permit-missing')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // 归属说明（合并融合 2026-09-28）：main 的边界策略下，「不存在路径 / 指向文件 / 越界」
  // 三类结构性错误由 gate 的 path 规则与 permit 签发层前置拦截（gate 不会为它们签发
  // directory permit；permit identity 校验也会把「stat 后目录消失」拒为
  // read-directory-unavailable）——R8 的 opendir 五类分类仅作为 permit 校验通过后
  // 的竞态防护保留（TOCTOU 窗口），结构性场景的验收归属 gate/permit 层测试
  // （toolCallGate.test.ts 的 V 系列 / readReadIntegration）。
})
