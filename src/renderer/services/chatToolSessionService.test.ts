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

  it('accumulates progressOutputRaw from rawDelta chunks', () => {
    const { applyAssistantPatch } = setupController()
    handlers.progress?.({
      requestId: 'req-1',
      toolUseId: 'tool-1',
      status: 'shell',
      rawDelta: Buffer.from('hel').toString('base64'),
      seq: 1
    })
    handlers.progress?.({
      requestId: 'req-1',
      toolUseId: 'tool-1',
      status: 'shell',
      rawDelta: Buffer.from('lo').toString('base64'),
      seq: 2
    })
    const lastPatch = applyAssistantPatch.mock.calls.at(-1)?.[0] as {
      toolCalls?: { progressOutputRaw?: string }[]
    }
    const raw = lastPatch.toolCalls?.[0]?.progressOutputRaw ?? ''
    expect(Buffer.from(raw, 'base64').toString('utf8')).toBe('hello')
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

describe('createToolChatController applyConfirmOutcome', () => {
  const unsub = vi.fn()
  const localHandlers: { use?: (d: unknown) => void; confirm?: (d: unknown) => void } = {}

  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        toolOnUse: vi.fn((cb: (d: unknown) => void) => {
          localHandlers.use = cb
          return unsub
        }),
        toolOnConfirmRequest: vi.fn((cb: (d: unknown) => void) => {
          localHandlers.confirm = cb
          return unsub
        }),
        toolOnProgress: vi.fn(() => unsub),
        toolOnResult: vi.fn(() => unsub)
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('optimistically marks browser confirm as executing', () => {
    const applyAssistantPatch = vi.fn()
    const controller = createToolChatController({
      dispatch: vi.fn(),
      assistantMessageId: 'msg-1',
      getRequestId: () => 'req-1',
      applyAssistantPatch
    })
    controller.subscribe()
    localHandlers.use?.({
      requestId: 'req-1',
      toolUse: { id: 'tool-browser', name: 'browser', input: { action: 'navigate', url: 'https://example.com' } }
    })
    localHandlers.confirm?.({
      requestId: 'req-1',
      toolUseId: 'tool-browser',
      toolName: 'browser',
      input: {},
      riskLevel: 'medium'
    })
    controller.applyConfirmOutcome('tool-browser', true)
    const lastPatch = applyAssistantPatch.mock.calls.at(-1)?.[0] as {
      toolCalls?: { status: string; progressOutput?: string }[]
    }
    expect(lastPatch.toolCalls?.[0]?.status).toBe('executing')
    expect(lastPatch.toolCalls?.[0]?.progressOutput).toBe('正在准备浏览器…')
  })
})
