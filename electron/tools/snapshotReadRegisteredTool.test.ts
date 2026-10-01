import { describe, expect, it, vi } from 'vitest'
import { executeRegisteredTool } from './toolInvocationCoordinator'
import { createSnapshotReadRegisteredTool } from './snapshotReadRegisteredTool'
import type { ToolExecutionContext } from './types'

describe('snapshot read caller binding', () => {
  it.each([
    ['null', null], ['array', []], ['string', 'query'], ['number', 1], ['non-plain object', new Date()]
  ])('rejects malformed %s input instead of converting it to an empty default query', async (_shape, rawInput) => {
    const execute = vi.fn(async () => ({ success: true, data: { entries: ['unexpected default query'] } }))
    const context: ToolExecutionContext = {
      workDir: '/work', userDataDir: '/data', requestId: 'r-invalid', toolUseId: 'u-invalid', sessionId: 's',
      sendProgress: () => undefined, signal: new AbortController().signal,
      fileStateCache: new Map() as never, toolsConfig: {} as never, lane: 'desktop'
    }

    await expect(executeRegisteredTool(createSnapshotReadRegisteredTool('test.snapshot', execute), rawInput as unknown as Record<string, unknown>, {
      requestId: 'r-invalid', toolUseId: 'u-invalid', signal: context.signal, executionContext: context
    }, {
      confirm: async () => true,
      dispatch: async (_handle, _context, run) => run(new AbortController().signal)
    })).rejects.toThrow('INVALID_CANONICAL_TOOL_INPUT')
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects remote identity drift before dispatch', async () => {
    const execute = vi.fn(async () => ({ success: true, data: { value: 'authorized snapshot' } }))
    const context: ToolExecutionContext = {
      workDir: '/work', userDataDir: '/data', requestId: 'r', toolUseId: 'u', sessionId: 's',
      sendProgress: () => undefined, signal: new AbortController().signal,
      fileStateCache: new Map() as never, toolsConfig: {} as never, lane: 'feishu',
      remoteContext: { source: 'feishu', messageId: 'approved-message', confirmPolicy: {} as never, authOwner: 'owner-a' }
    }
    await expect(executeRegisteredTool(createSnapshotReadRegisteredTool('test.snapshot', execute), {}, {
      requestId: 'r', toolUseId: 'u', signal: context.signal, executionContext: context
    }, {
      confirm: async () => { context.remoteContext!.messageId = 'different-message'; return true },
      dispatch: async (_handle, _context, run) => run(new AbortController().signal)
    })).rejects.toThrow('SNAPSHOT_READ_CONTEXT_CHANGED')
    expect(execute).toHaveBeenCalledOnce()
  })
})
