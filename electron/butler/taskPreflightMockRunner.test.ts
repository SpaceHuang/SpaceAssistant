import { describe, expect, it, vi } from 'vitest'
import { createTaskPreflightMockRunner, DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS, type TaskPreflightMockModelResponse } from './taskPreflightMockRunner'

const tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }]

function toolResponse(round: number, toolName = 'read_file', input: unknown = { path: '/workspace/report.md' }): TaskPreflightMockModelResponse {
  return { kind: 'tool_calls', outputTokens: 2, calls: [{ id: `call-${round}`, name: toolName, input }] }
}

describe('createTaskPreflightMockRunner', () => {
  it('records proposed parameters and only returns an explicitly synthetic mock result', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(toolResponse(1, 'read_file', { path: '/workspace/report.md', mode: 'head' }))
      .mockResolvedValueOnce({ kind: 'final', outputTokens: 3, value: { summary: 'done' } })
    const readFileMock = vi.fn(async () => ({ content: '[synthetic file content]', completeness: 'synthetic' as const }))
    const runner = createTaskPreflightMockRunner({
      tools,
      model: { generate },
      mockAdapters: { read_file: readFileMock }
    })

    const result = await runner.run({ prompt: 'Summarize report.md' }, new AbortController().signal)

    expect(generate).toHaveBeenCalledTimes(2)
    expect(readFileMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'read_file', input: { path: '/workspace/report.md', mode: 'head' } }), expect.any(AbortSignal))
    expect(result).toMatchObject({
      status: 'complete',
      value: { summary: 'done' },
      trace: [{ kind: 'proposed-tool-call', toolName: 'read_file', input: { path: '/workspace/report.md', mode: 'head' }, resultKind: 'synthetic' }]
    })
  })

  it('fails closed for a tool call that has no mock adapter', async () => {
    const generate = vi.fn().mockResolvedValueOnce(toolResponse(1, 'run_shell', { command: 'git log', workingDirectory: '/workspace' }))
    const runner = createTaskPreflightMockRunner({ tools, model: { generate }, mockAdapters: { read_file: vi.fn() } })

    const result = await runner.run({ prompt: 'Check Git history' }, new AbortController().signal)

    expect(result).toMatchObject({ status: 'incomplete', reason: 'mock_adapter_unavailable', trace: [{ kind: 'proposed-tool-call', toolName: 'run_shell', dispatch: 'blocked' }] })
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('does not start when any advertised tool is missing a mock adapter', async () => {
    const generate = vi.fn()
    const runner = createTaskPreflightMockRunner({ tools, model: { generate }, mockAdapters: {} })

    const result = await runner.run({ prompt: 'Read report.md' }, new AbortController().signal)

    expect(result).toMatchObject({ status: 'incomplete', reason: 'mock_catalog_incomplete', trace: [] })
    expect(generate).not.toHaveBeenCalled()
  })

  it('stops at the model round limit without making another model request', async () => {
    const generate = vi.fn().mockImplementation(async () => toolResponse(generate.mock.calls.length))
    const runner = createTaskPreflightMockRunner({
      tools,
      model: { generate },
      mockAdapters: { read_file: vi.fn(async () => ({ content: 'synthetic', completeness: 'synthetic' as const })) },
      limits: { ...DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS, maxModelRounds: 2 }
    })

    const result = await runner.run({ prompt: 'Read report.md' }, new AbortController().signal)

    expect(generate).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ status: 'incomplete', reason: 'model_round_limit', modelRounds: 2, trace: [{ dispatch: 'simulated' }, { dispatch: 'simulated' }] })
  })

  it('stops before dispatching a tool call that would exceed the total mock call limit', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(toolResponse(1))
      .mockResolvedValueOnce(toolResponse(2))
    const readFileMock = vi.fn(async () => ({ content: 'synthetic', completeness: 'synthetic' as const }))
    const runner = createTaskPreflightMockRunner({
      tools,
      model: { generate },
      mockAdapters: { read_file: readFileMock },
      limits: { ...DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS, maxToolCalls: 1 }
    })

    const result = await runner.run({ prompt: 'Read report.md' }, new AbortController().signal)

    expect(readFileMock).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ status: 'incomplete', reason: 'tool_call_limit', toolCalls: 1, trace: [
      { dispatch: 'simulated', input: { path: '/workspace/report.md' } },
      { dispatch: 'not-dispatched', input: { path: '/workspace/report.md' } }
    ] })
  })

  it('rejects a response that exceeds the per-round output token budget', async () => {
    const generate = vi.fn().mockResolvedValueOnce({ kind: 'final', outputTokens: 101, value: 'too large' })
    const runner = createTaskPreflightMockRunner({
      tools: [], model: { generate }, mockAdapters: {},
      limits: { ...DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS, maxOutputTokensPerRound: 100 }
    })

    await expect(runner.run({ prompt: 'check' }, new AbortController().signal))
      .resolves.toMatchObject({ status: 'incomplete', reason: 'model_output_limit', modelRounds: 1, outputTokens: 0 })
  })

  it('uses the selected model output allowance on every round without a separate cumulative token cap', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ ...toolResponse(1), outputTokens: 80 })
      .mockResolvedValueOnce({ kind: 'final', outputTokens: 90, value: 'done' })
    const runner = createTaskPreflightMockRunner({
      tools, model: { generate }, mockAdapters: { read_file: vi.fn(async () => ({ content: 'synthetic', completeness: 'synthetic' as const })) },
      limits: { ...DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS, maxOutputTokensPerRound: 100 }
    })

    await expect(runner.run({ prompt: 'check' }, new AbortController().signal))
      .resolves.toMatchObject({ status: 'complete', modelRounds: 2, outputTokens: 170 })
    expect(generate.mock.calls.map(([request]) => request.maxOutputTokens)).toEqual([100, 100])
  })

  it('stops and marks coverage incomplete when a mock cannot faithfully model a result', async () => {
    const generate = vi.fn().mockResolvedValueOnce(toolResponse(1))
    const runner = createTaskPreflightMockRunner({
      tools,
      model: { generate },
      mockAdapters: { read_file: vi.fn(async () => ({ content: '', completeness: 'unavailable' as const })) }
    })

    const result = await runner.run({ prompt: 'Read report.md' }, new AbortController().signal)

    expect(result).toMatchObject({ status: 'incomplete', reason: 'mock_result_unavailable', trace: [{ resultKind: 'unavailable' }] })
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('enforces per-model and whole-run time limits and aborts outstanding work', async () => {
    vi.useFakeTimers()
    try {
      const generate = vi.fn((_request: unknown, signal: AbortSignal) => new Promise<TaskPreflightMockModelResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }))
      const runner = createTaskPreflightMockRunner({
        tools,
        model: { generate },
        mockAdapters: { read_file: vi.fn() },
        limits: { ...DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS, modelRequestTimeoutMs: 10, totalTimeoutMs: 25 }
      })

      const resultPromise = runner.run({ prompt: 'Read report.md' }, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(11)
      await expect(resultPromise).resolves.toMatchObject({ status: 'incomplete', reason: 'model_request_timeout', modelRounds: 1 })
      expect(generate.mock.calls[0]?.[1].aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts an outstanding mock adapter when the whole preflight budget expires', async () => {
    vi.useFakeTimers()
    try {
      const generate = vi.fn().mockResolvedValueOnce(toolResponse(1))
      const mockAdapter = vi.fn((_call: unknown, signal: AbortSignal) => new Promise<{ content: string; completeness: 'synthetic' }>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }))
      const runner = createTaskPreflightMockRunner({
        tools,
        model: { generate },
        mockAdapters: { read_file: mockAdapter },
        limits: { ...DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS, totalTimeoutMs: 25 }
      })

      const resultPromise = runner.run({ prompt: 'Read report.md' }, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(26)

      await expect(resultPromise).resolves.toMatchObject({ status: 'incomplete', reason: 'total_timeout', trace: [{ dispatch: 'simulated' }] })
      expect(mockAdapter.mock.calls[0]?.[1].aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never dispatches a late model response after the whole preflight budget expires', async () => {
    vi.useFakeTimers()
    try {
      const generate = vi.fn(() => new Promise<TaskPreflightMockModelResponse>((resolve) => {
        // Simulate a provider that ignores AbortSignal and resolves after the host deadline.
        setTimeout(() => resolve(toolResponse(1)), 15)
      }))
      const mockAdapter = vi.fn(async () => ({ content: 'synthetic', completeness: 'synthetic' as const }))
      const runner = createTaskPreflightMockRunner({
        tools,
        model: { generate },
        mockAdapters: { read_file: mockAdapter },
        limits: { ...DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS, modelRequestTimeoutMs: 20, totalTimeoutMs: 10 }
      })

      const resultPromise = runner.run({ prompt: 'Read report.md' }, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(11)
      await expect(resultPromise).resolves.toMatchObject({ status: 'incomplete', reason: 'total_timeout' })
      await vi.advanceTimersByTimeAsync(15)
      await Promise.resolve()

      expect(generate).toHaveBeenCalledOnce()
      expect(mockAdapter).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never dispatches later tool calls after an in-flight mock ignores the total-budget abort', async () => {
    vi.useFakeTimers()
    try {
      const generate = vi.fn().mockResolvedValueOnce({
        kind: 'tool_calls', outputTokens: 2,
        calls: [
          { id: 'call-1', name: 'read_file', input: { path: '/workspace/a.md' } },
          { id: 'call-2', name: 'read_file', input: { path: '/workspace/b.md' } }
        ]
      } satisfies TaskPreflightMockModelResponse)
      const mockAdapter = vi.fn(() => new Promise<{ content: string; completeness: 'synthetic' }>((resolve) => {
        // Simulate a Mock implementation that finishes after abort and ignores its signal.
        setTimeout(() => resolve({ content: 'synthetic', completeness: 'synthetic' }), 15)
      }))
      const runner = createTaskPreflightMockRunner({
        tools, model: { generate }, mockAdapters: { read_file: mockAdapter },
        limits: { ...DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS, modelRequestTimeoutMs: 20, totalTimeoutMs: 10 }
      })

      const resultPromise = runner.run({ prompt: 'Read two files' }, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(11)
      await expect(resultPromise).resolves.toMatchObject({ status: 'incomplete', reason: 'total_timeout' })
      await vi.advanceTimersByTimeAsync(15)

      expect(mockAdapter).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
