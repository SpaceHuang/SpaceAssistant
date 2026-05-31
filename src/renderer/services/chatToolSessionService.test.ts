import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createToolChatController } from './chatToolSessionService'

describe('createToolChatController progressOutput', () => {
  const unsub = vi.fn()
  const handlers: {
    use?: (d: unknown) => void
    progress?: (d: unknown) => void
    result?: (d: unknown) => void
  } = {}

  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        toolOnUse: vi.fn((cb: (d: unknown) => void) => {
          handlers.use = cb
          return unsub
        }),
        toolOnConfirmRequest: vi.fn(() => unsub),
        toolOnProgress: vi.fn((cb: (d: unknown) => void) => {
          handlers.progress = cb
          return unsub
        }),
        toolOnResult: vi.fn((cb: (d: unknown) => void) => {
          handlers.result = cb
          return unsub
        })
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function setupController(getRequestId = () => 'req-1') {
    const applyAssistantPatch = vi.fn()
    const controller = createToolChatController({
      dispatch: vi.fn(),
      assistantMessageId: 'msg-1',
      getRequestId,
      applyAssistantPatch
    })
    controller.subscribe()
    handlers.use?.({
      requestId: 'req-1',
      toolUse: { id: 'tool-1', name: 'run_shell', input: { command: 'npm install' } }
    })
    return { applyAssistantPatch }
  }

  it('writes progressOutput from tool:progress message', () => {
    const { applyAssistantPatch } = setupController()
    handlers.progress?.({
      requestId: 'req-1',
      toolUseId: 'tool-1',
      status: 'executing',
      message: 'added 47 packages'
    })
    const lastPatch = applyAssistantPatch.mock.calls.at(-1)?.[0] as { toolCalls?: { progressOutput?: string }[] }
    expect(lastPatch.toolCalls?.[0]?.progressOutput).toBe('added 47 packages')
    expect(lastPatch.toolCalls?.[0]?.status).toBe('executing')
  })

  it('keeps previous progressOutput when message is absent', () => {
    const { applyAssistantPatch } = setupController()
    handlers.progress?.({
      requestId: 'req-1',
      toolUseId: 'tool-1',
      status: 'executing',
      message: 'line one'
    })
    handlers.progress?.({
      requestId: 'req-1',
      toolUseId: 'tool-1',
      status: 'executing'
    })
    const lastPatch = applyAssistantPatch.mock.calls.at(-1)?.[0] as { toolCalls?: { progressOutput?: string }[] }
    expect(lastPatch.toolCalls?.[0]?.progressOutput).toBe('line one')
  })

  it('ignores progress for stale requestId', () => {
    const { applyAssistantPatch } = setupController()
    handlers.progress?.({
      requestId: 'other',
      toolUseId: 'tool-1',
      status: 'executing',
      message: 'ignored'
    })
    expect(applyAssistantPatch).toHaveBeenCalledTimes(1)
  })

  it('writes progressOutputRaw from terminal mode progress', () => {
    const { applyAssistantPatch } = setupController()
    handlers.progress?.({
      requestId: 'req-1',
      toolUseId: 'tool-1',
      status: 'shell',
      raw: Buffer.from('line\r').toString('base64'),
      seq: 1
    })
    const lastPatch = applyAssistantPatch.mock.calls.at(-1)?.[0] as {
      toolCalls?: { progressOutputRaw?: string; progressSeq?: number }[]
    }
    expect(lastPatch.toolCalls?.[0]?.progressOutputRaw).toBeTruthy()
    expect(lastPatch.toolCalls?.[0]?.progressSeq).toBe(1)
  })

  it('preserves progressOutput after tool:result', () => {
    const { applyAssistantPatch } = setupController()
    handlers.progress?.({
      requestId: 'req-1',
      toolUseId: 'tool-1',
      status: 'executing',
      message: 'live tail'
    })
    handlers.result?.({
      requestId: 'req-1',
      toolUseId: 'tool-1',
      result: {
        success: true,
        data: { stdout: 'done', stderr: '', exitCode: 0 }
      }
    })
    const lastPatch = applyAssistantPatch.mock.calls.at(-1)?.[0] as { toolCalls?: { progressOutput?: string }[] }
    expect(lastPatch.toolCalls?.[0]?.progressOutput).toBe('live tail')
    expect(lastPatch.toolCalls?.[0]?.status).toBe('completed')
  })
})
