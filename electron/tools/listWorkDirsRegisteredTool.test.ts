import { describe, expect, it, vi } from 'vitest'
import { executeRegisteredTool } from './toolInvocationCoordinator'
import { createListWorkDirsRegisteredTool } from './listWorkDirsRegisteredTool'
import type { ToolExecutionContext } from './types'

function setup() {
  const result = { success: true, data: { directories: [{ id: 'p1', name: 'Project', path: '/project', isBound: true, isDefault: true, isActive: true, isSensitive: false, aliases: [] }], currentBoundId: 'p1', activeProfileId: 'p1' } }
  const execute = vi.fn(async () => structuredClone(result))
  const context: ToolExecutionContext = {
    workDir: '/project', userDataDir: '/data', requestId: 'r', toolUseId: 'u', sessionId: 's',
    sendProgress: () => undefined, signal: new AbortController().signal,
    fileStateCache: new Map() as never, toolsConfig: {} as never, lane: 'feishu',
    remoteContext: { source: 'feishu', messageId: 'm1', confirmPolicy: {} as never, authOwner: 'owner', authorizationGeneration: 1 },
    workDirManager: {} as never, appDatabase: {} as never
  }
  return { result, execute, context }
}

describe('list_work_dirs prepared registration', () => {
  it.each([
    ['null', null], ['array', []], ['string', 'profile'], ['number', 1], ['non-plain object', new Date()]
  ])('rejects malformed %s input before reading directory state', async (_shape, rawInput) => {
    const { execute, context } = setup()
    await expect(executeRegisteredTool(createListWorkDirsRegisteredTool({ name: 'list_work_dirs', execute } as never), rawInput as never, {
      requestId: 'r', toolUseId: 'u', signal: context.signal, executionContext: context
    }, {
      confirm: async () => true,
      dispatch: async (_handle, _context, run) => run(new AbortController().signal)
    })).rejects.toThrow('INVALID_CANONICAL_TOOL_INPUT')
    expect(execute).not.toHaveBeenCalled()
  })

  it('remote caller identity drift after confirmation blocks dispatch', async () => {
    const { execute, context } = setup()
    let dispatched = false
    await expect(executeRegisteredTool(createListWorkDirsRegisteredTool({ name: 'list_work_dirs', execute } as never), {}, {
      requestId: 'r', toolUseId: 'u', signal: context.signal, executionContext: context
    }, {
      confirm: async () => { context.remoteContext!.messageId = 'm2'; return true },
      dispatch: async (_handle, _context, run) => { dispatched = true; return run(new AbortController().signal) }
    })).rejects.toThrow('LIST_WORKDIRS_PREPARED_CALLER_CHANGED')
    expect(dispatched).toBe(false)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('configuration drift after confirmation rejects instead of returning a changed listing', async () => {
    const { result, execute, context } = setup()
    let readCount = 0
    execute.mockImplementation(async () => {
      readCount += 1
      return readCount === 1 ? structuredClone(result) : { success: true, data: { directories: [], currentBoundId: '', activeProfileId: '' } }
    })
    await expect(executeRegisteredTool(createListWorkDirsRegisteredTool({ name: 'list_work_dirs', execute } as never), {}, {
      requestId: 'r', toolUseId: 'u', signal: context.signal, executionContext: context
    }, {
      confirm: async () => true,
      dispatch: async (_handle, _context, run) => run(new AbortController().signal)
    })).rejects.toThrow('LIST_WORKDIRS_PREPARED_SNAPSHOT_CHANGED')
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('returns the exact listing validated before dispatch', async () => {
    const { result, execute, context } = setup()
    await expect(executeRegisteredTool(createListWorkDirsRegisteredTool({ name: 'list_work_dirs', execute } as never), {}, {
      requestId: 'r', toolUseId: 'u', signal: context.signal, executionContext: context
    }, {
      confirm: async () => true,
      dispatch: async (_handle, _context, run) => run(new AbortController().signal)
    })).resolves.toEqual(result)
    expect(execute).toHaveBeenCalledTimes(3)
  })
})
