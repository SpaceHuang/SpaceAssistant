import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { FileHandle } from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import type { ToolExecutionContext } from './types'
import { readFileExecutor } from './builtinExecutors'
import { classifyFileReadError, fileReadErrorHint, isExecutionOutcomeUncertainError } from './toolExecutionResource'
import { settleExecutorUnhandledError } from './registeredAgentTurnTools'

class FakeUncertainError extends Error {
  constructor() {
    super('outbound may have happened')
    this.name = 'FakeUncertainError'
  }
}

/** 未设置 name 的 Uncertain 类：靠 constructor.name 命中 */
class UnnamedUncertainError extends Error {}

describe('settleExecutorUnhandledError（统一出口：漏网异常的结算决策）', () => {
  it.each([
    ['name 后缀命中', new FakeUncertainError()],
    ['constructor.name 后缀命中', new UnnamedUncertainError()]
  ])('%s → 穿透（副作用不确定，保持整轮 unknown-after-dispatch）', (_label, error) => {
    expect(settleExecutorUnhandledError(error, 'wechat_send', 'read')).toMatchObject({ rethrow: true })
  })

  it('AbortError → 穿透（取消语义保持现状）', () => {
    expect(settleExecutorUnhandledError(new DOMException('Aborted', 'AbortError'), 'read_file', 'read')).toMatchObject({ rethrow: true })
  })

  it('写/执行类工具的漏网异常一律穿透（动作可能已发生，保守结算）', () => {
    for (const actionClass of ['write', 'execute', undefined]) {
      expect(settleExecutorUnhandledError(Object.assign(new Error('file closed'), { code: 'EBADF' }), 'write_file', actionClass)).toMatchObject({ rethrow: true })
    }
  })

  it('普通错误不误判为 Uncertain', () => {
    expect(isExecutionOutcomeUncertainError(new Error('plain'))).toBe(false)
  })

  it('读类工具漏网异常 → 降级为工具级失败结果，retryable 与 executor 内降级同信号', () => {
    const transient = settleExecutorUnhandledError(Object.assign(new Error('file closed'), { code: 'EBADF' }), 'read_file', 'read')
    expect(transient.rethrow).toBe(false)
    if (!transient.rethrow) {
      expect(transient.result).toMatchObject({
        success: false,
        error: expect.stringContaining('EBADF'),
        diagnostic: { caseId: 'executor-unhandled-error', retryable: true, category: 'executor' }
      })
    }
    const programmingError = settleExecutorUnhandledError(new TypeError('boom'), 'read_file', 'read')
    expect(programmingError.rethrow).toBe(false)
    if (!programmingError.rethrow) {
      expect(programmingError.result).toMatchObject({
        success: false,
        diagnostic: { caseId: 'executor-unhandled-error', retryable: false, category: 'executor' }
      })
    }
  })

  it('降级结果保留 errno 码（toToolUserError 退到通用文案时模型仍能看到关键信号）', () => {
    const settlement = settleExecutorUnhandledError(
      Object.assign(new Error("EACCES: permission denied, open 'C:\\sec\\a.txt'"), { code: 'EACCES' }),
      'read_file',
      'read'
    )
    expect(settlement.rethrow).toBe(false)
    if (!settlement.rethrow) {
      expect(settlement.result.error as string).toContain('EACCES')
      expect(settlement.result).toMatchObject({ diagnostic: { retryable: false } })
    }
  })
})

describe('fileReadErrorHint（按 errno 给模型可执行的指引）', () => {
  it('ENOENT 指向 list_directory 自助确认', () => {
    expect(fileReadErrorHint('environment', 'ENOENT')).toContain('list_directory')
  })
  it('EACCES/EPERM 指向权限检查', () => {
    expect(fileReadErrorHint('environment', 'EACCES')).toContain('权限')
    expect(fileReadErrorHint('environment', 'EPERM')).toContain('权限')
  })
  it('EISDIR 指向目录工具', () => {
    expect(fileReadErrorHint('environment', 'EISDIR')).toContain('list_directory')
  })
  it('瞬态类给重试指引，未识别 code 给保守默认', () => {
    expect(fileReadErrorHint('transient', 'EBADF')).toContain('重试')
    expect(fileReadErrorHint('environment', 'EBUSY')).toContain('检查')
  })
})

vi.mock('../confirmation/readPermitExecutor', () => ({
  resolveReadPermitTarget: vi.fn()
}))

import { resolveReadPermitTarget } from '../confirmation/readPermitExecutor'

const mockedResolve = vi.mocked(resolveReadPermitTarget)

function makeCtx(workDir: string, signal: AbortSignal): ToolExecutionContext {
  return {
    workDir,
    userDataDir: path.join(workDir, '.userdata'),
    requestId: 'req-fs-degrade',
    toolUseId: 'tool-fs-degrade',
    sessionId: 'session-fs-degrade',
    sendProgress: vi.fn(),
    signal,
    fileStateCache: new FileStateCache(),
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false }
  }
}

/** 事故等价物：授予方已返回、但句柄已被关闭（2026-10 会话 38 的 `EBADF: file closed`） */
async function closedHandleOn(realFile: string): Promise<FileHandle> {
  const handle = await fs.open(realFile, 'r')
  await handle.close()
  return handle
}

function handleWhoseStatThrows(code: string): FileHandle {
  return {
    stat: async () => {
      throw Object.assign(new Error(`${code}: simulated`), { code })
    },
    close: async () => undefined
  } as unknown as FileHandle
}

describe('classifyFileReadError', () => {
  it.each(['EBADF', 'EBUSY', 'EMFILE', 'ENFILE', 'EAGAIN'] as const)('%s → transient', (code) => {
    expect(classifyFileReadError(Object.assign(new Error(code), { code }))).toBe('transient')
  })

  it.each(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP'] as const)('%s → environment', (code) => {
    expect(classifyFileReadError(Object.assign(new Error(code), { code }))).toBe('environment')
  })

  it('非 errno 错误与 AbortError 不降级', () => {
    expect(classifyFileReadError(new TypeError('boom'))).toBeNull()
    expect(classifyFileReadError(new Error('BINARY'))).toBeNull()
    expect(classifyFileReadError(new DOMException('Aborted', 'AbortError'))).toBeNull()
    expect(classifyFileReadError(null)).toBeNull()
  })
})

describe('read_file executor 对 fs 异常的降级（2026-10 会话 38 file closed 事故回归）', () => {
  let tmpDir: string
  let realFile: string

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-fs-degrade-')))
    realFile = path.join(tmpDir, 'note.txt')
    await fs.writeFile(realFile, 'hello')
    mockedResolve.mockReset()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function grantAndExecute(ctx: ToolExecutionContext, fileHandle: FileHandle) {
    mockedResolve.mockResolvedValue({ ok: true, path: realFile, fileHandle } as Awaited<ReturnType<typeof resolveReadPermitTarget>>)
    return readFileExecutor.execute({ path: 'note.txt' }, ctx)
  }

  it('授予的句柄已被关闭（EBADF file closed）→ 工具级可重试错误，而非抛出', async () => {
    const result = await grantAndExecute(makeCtx(tmpDir, new AbortController().signal), await closedHandleOn(realFile))
    expect(result.success).toBe(false)
    expect(result.error).toContain('EBADF')
    expect(result.error).toContain('note.txt')
    expect(result.diagnostic).toMatchObject({ caseId: 'read-fs-error', retryable: true, category: 'environment' })
  })

  it('确定性环境错误（EACCES）→ 降级为工具级错误但 retryable: false', async () => {
    const result = await grantAndExecute(makeCtx(tmpDir, new AbortController().signal), handleWhoseStatThrows('EACCES'))
    expect(result.success).toBe(false)
    expect(result.diagnostic).toMatchObject({ caseId: 'read-fs-error', retryable: false })
  })

  it('非 fs 编程错误仍向上抛出（不吞错）', async () => {
    mockedResolve.mockResolvedValue({
      ok: true,
      path: realFile,
      fileHandle: {
        stat: async () => {
          throw new TypeError('boom')
        },
        close: async () => undefined
      } as unknown as FileHandle
    } as Awaited<ReturnType<typeof resolveReadPermitTarget>>)
    await expect(readFileExecutor.execute({ path: 'note.txt' }, makeCtx(tmpDir, new AbortController().signal))).rejects.toThrow('boom')
  })

  it('用户已取消时优先返回取消结果，不误报为 fs 错误', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await grantAndExecute(makeCtx(tmpDir, controller.signal), await closedHandleOn(realFile))
    expect(result.success).toBe(false)
    expect(result.error).toBe('用户取消执行')
  })
})
