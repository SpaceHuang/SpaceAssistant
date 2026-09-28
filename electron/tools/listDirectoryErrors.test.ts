import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'

import { classifyDirectoryError, listDirectoryExecutor, type ToolExecutionContext } from './builtinExecutors'
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

describe('classifyDirectoryError（R8 四分类）', () => {
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

describe('list_directory 错误分类（R8）', () => {
  it('T-R8-1a：不存在路径 → PATH_NOT_FOUND + FILE_NOT_FOUND + suggestions[list-parent]', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ls-r8-'))
    try {
      const r = (await listDirectoryExecutor.execute(
        { path: 'no-such-dir' },
        ctx({ workDir: root })
      )) as ToolExecutorResult
      expect(r.success).toBe(false)
      expect(r.error).toBe('FILE_NOT_FOUND')
      expect((r.data as { errorClass: string }).errorClass).toBe('PATH_NOT_FOUND')
      expect((r.data as { suggestions: string[] }).suggestions).toContain('list-parent')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('T-R8-1b：指向文件的路径 → NOT_A_DIRECTORY + TARGET_NOT_DIRECTORY + 建议 use-read-file（与「不存在」文案/类目可分）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ls-r8-'))
    fs.writeFileSync(path.join(root, 'file.txt'), 'x')
    try {
      const r = (await listDirectoryExecutor.execute(
        { path: 'file.txt' },
        ctx({ workDir: root })
      )) as ToolExecutorResult
      expect(r.success).toBe(false)
      expect(r.error).toBe('TARGET_NOT_DIRECTORY')
      expect((r.data as { errorClass: string }).errorClass).toBe('NOT_A_DIRECTORY')
      expect((r.data as { suggestions: string[] }).suggestions).toContain('use-read-file')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('T-R8-1c：越界路径 → PATH_OUTSIDE_WORKDIR（可与其他类目区分）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ls-r8-'))
    try {
      const r = (await listDirectoryExecutor.execute(
        { path: '../outside' },
        ctx({ workDir: root })
      )) as ToolExecutorResult
      expect(r.success).toBe(false)
      expect((r.data as { errorClass: string }).errorClass).toBe('PATH_OUTSIDE_WORKDIR')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('T-R8-2：abort 注入 → READ_TIMEOUT + retryable:true（文案区别于其他三类）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ls-r8-'))
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
    try {
      const ac = new AbortController()
      ac.abort()
      const r = (await listDirectoryExecutor.execute(
        { path: 'sub' },
        ctx({ workDir: root, signal: ac.signal })
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
})
