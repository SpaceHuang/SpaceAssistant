import type { AutomationTaskPreflightTraceItem } from '../../src/shared/automationTaskTypes'

export const DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS = {
  maxModelRounds: 5,
  maxToolCalls: 12,
  modelRequestTimeoutMs: 20_000,
  totalTimeoutMs: 60_000,
  maxOutputTokensPerRound: 2_048,
  maxTotalOutputTokens: 10_240
} as const

export type TaskPreflightMockLimits = {
  maxModelRounds: number
  maxToolCalls: number
  modelRequestTimeoutMs: number
  totalTimeoutMs: number
  maxOutputTokensPerRound: number
  maxTotalOutputTokens: number
}

export type TaskPreflightMockTool = { name: string; description: string; inputSchema: unknown }
export type TaskPreflightMockToolCall = { id: string; name: string; input: unknown }
export type TaskPreflightMockModelResponse =
  | { kind: 'tool_calls'; calls: TaskPreflightMockToolCall[]; outputTokens: number }
  | { kind: 'final'; value: unknown; outputTokens: number }

export type TaskPreflightMockToolResult = { content: string; completeness: 'synthetic' | 'unavailable' }
export type TaskPreflightMockAdapter = (call: TaskPreflightMockToolCall, signal: AbortSignal) => Promise<TaskPreflightMockToolResult>
export type TaskPreflightMockTraceItem = AutomationTaskPreflightTraceItem

export type TaskPreflightMockRunnerResult =
  | { status: 'complete'; value: unknown; trace: TaskPreflightMockTraceItem[]; modelRounds: number; toolCalls: number; outputTokens: number }
  | { status: 'incomplete'; reason: string; trace: TaskPreflightMockTraceItem[]; modelRounds: number; toolCalls: number; outputTokens: number }

export type TaskPreflightMockMessage = { role: 'user' | 'assistant' | 'tool'; content: unknown }
type TaskPreflightMockModel = {
  generate: (
    request: { messages: readonly TaskPreflightMockMessage[]; tools: readonly TaskPreflightMockTool[]; maxOutputTokens: number },
    signal: AbortSignal
  ) => Promise<TaskPreflightMockModelResponse>
}

type RunnerOptions = {
  tools: readonly TaskPreflightMockTool[]
  model: TaskPreflightMockModel
  mockAdapters: Readonly<Record<string, TaskPreflightMockAdapter | undefined>>
  limits?: TaskPreflightMockLimits
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function validateLimits(limits: TaskPreflightMockLimits): boolean {
  return Object.values(limits).every(isPositiveFinite)
    && limits.maxModelRounds <= DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS.maxModelRounds
    && limits.maxToolCalls <= DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS.maxToolCalls
    && limits.modelRequestTimeoutMs <= DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS.modelRequestTimeoutMs
    && limits.totalTimeoutMs <= DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS.totalTimeoutMs
    && limits.maxOutputTokensPerRound <= DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS.maxOutputTokensPerRound
    && limits.maxTotalOutputTokens <= DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS.maxTotalOutputTokens
}

function incomplete(
  reason: string,
  trace: TaskPreflightMockTraceItem[],
  modelRounds: number,
  toolCalls: number,
  outputTokens: number
): TaskPreflightMockRunnerResult {
  return { status: 'incomplete', reason, trace: trace.map((item) => structuredClone(item)), modelRounds, toolCalls, outputTokens }
}

async function callModelWithTimeout<T>(
  modelCall: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number
): Promise<T> {
  if (parentSignal.aborted) throw new Error('PREFLIGHT_CANCELLED')
  const localController = new AbortController()
  const abortFromParent = () => localController.abort(parentSignal.reason)
  if (parentSignal.aborted) abortFromParent()
  else parentSignal.addEventListener('abort', abortFromParent, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  let didTimeout = false
  let rejectParentAbort: ((reason?: unknown) => void) | undefined
  const parentAborted = new Promise<never>((_, reject) => { rejectParentAbort = reject })
  const onParentAbort = () => {
    localController.abort(parentSignal.reason)
    rejectParentAbort?.(new Error('PREFLIGHT_CANCELLED'))
  }
  parentSignal.addEventListener('abort', onParentAbort, { once: true })
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      didTimeout = true
      localController.abort(new Error('PREFLIGHT_MODEL_REQUEST_TIMEOUT'))
      reject(new Error('PREFLIGHT_MODEL_REQUEST_TIMEOUT'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([modelCall(localController.signal), timeout, parentAborted])
  } catch (error) {
    if (didTimeout) throw new Error('PREFLIGHT_MODEL_REQUEST_TIMEOUT')
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    parentSignal.removeEventListener('abort', onParentAbort)
    parentSignal.removeEventListener('abort', abortFromParent)
  }
}

function isValidModelResponse(value: unknown): value is TaskPreflightMockModelResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!Number.isInteger(record.outputTokens) || Number(record.outputTokens) < 0) return false
  if (record.kind === 'final') return 'value' in record
  if (record.kind !== 'tool_calls' || !Array.isArray(record.calls) || record.calls.length === 0) return false
  return record.calls.every((call) => call !== null && typeof call === 'object'
    && typeof (call as Record<string, unknown>).id === 'string'
    && typeof (call as Record<string, unknown>).name === 'string'
    && 'input' in (call as Record<string, unknown>))
}

export function createTaskPreflightMockRunner(options: RunnerOptions) {
  // system invariant (SYS-PREFLIGHT-001): host-owned limits gate every model round and Mock dispatch;
  // an advertised tool without an explicit adapter fails closed and cannot reach a production executor.
  const limits = options.limits ?? DEFAULT_TASK_PREFLIGHT_MOCK_LIMITS

  return {
    async run(input: { prompt: string }, parentSignal: AbortSignal): Promise<TaskPreflightMockRunnerResult> {
      const trace: TaskPreflightMockTraceItem[] = []
      let modelRounds = 0
      let toolCalls = 0
      let outputTokens = 0
      if (!validateLimits(limits)) return incomplete('invalid_budget', trace, modelRounds, toolCalls, outputTokens)

      const toolNames = new Set<string>()
      for (const tool of options.tools) {
        if (!tool.name || toolNames.has(tool.name) || typeof options.mockAdapters[tool.name] !== 'function') {
          return incomplete('mock_catalog_incomplete', trace, modelRounds, toolCalls, outputTokens)
        }
        toolNames.add(tool.name)
      }

      const overallController = new AbortController()
      const abortFromParent = () => overallController.abort(parentSignal.reason)
      if (parentSignal.aborted) abortFromParent()
      else parentSignal.addEventListener('abort', abortFromParent, { once: true })

      let totalTimedOut = false
      let totalTimer: ReturnType<typeof setTimeout> | undefined
      let resolveCancelled: (value: TaskPreflightMockRunnerResult) => void = () => undefined
      const onParentAbort = () => resolveCancelled(incomplete('cancelled', trace, modelRounds, toolCalls, outputTokens))
      const cancelled = new Promise<TaskPreflightMockRunnerResult>((resolve) => {
        resolveCancelled = resolve
        if (parentSignal.aborted) onParentAbort()
        else parentSignal.addEventListener('abort', onParentAbort, { once: true })
      })
      const totalTimeout = new Promise<TaskPreflightMockRunnerResult>((resolve) => {
        totalTimer = setTimeout(() => {
          totalTimedOut = true
          overallController.abort(new Error('PREFLIGHT_TOTAL_TIMEOUT'))
          resolve(incomplete('total_timeout', trace, modelRounds, toolCalls, outputTokens))
        }, limits.totalTimeoutMs)
      })

      const runLoop = async (): Promise<TaskPreflightMockRunnerResult> => {
        const messages: TaskPreflightMockMessage[] = [{ role: 'user', content: input.prompt }]

        for (let round = 0; round < limits.maxModelRounds; round += 1) {
          if (overallController.signal.aborted) return incomplete(parentSignal.aborted ? 'cancelled' : 'total_timeout', trace, modelRounds, toolCalls, outputTokens)
          modelRounds += 1
          let response: TaskPreflightMockModelResponse
          try {
            response = await callModelWithTimeout(
              (signal) => options.model.generate({ messages, tools: options.tools, maxOutputTokens: limits.maxOutputTokensPerRound }, signal),
              overallController.signal,
              limits.modelRequestTimeoutMs
            )
          } catch (error) {
            if (parentSignal.aborted) return incomplete('cancelled', trace, modelRounds, toolCalls, outputTokens)
            if (totalTimedOut) return incomplete('total_timeout', trace, modelRounds, toolCalls, outputTokens)
            if (error instanceof Error && error.message === 'PREFLIGHT_MODEL_REQUEST_TIMEOUT') return incomplete('model_request_timeout', trace, modelRounds, toolCalls, outputTokens)
            if (error instanceof Error && ['PREFLIGHT_MODEL_TRUNCATED_RESPONSE', 'PREFLIGHT_MODEL_INVALID_SCHEMA', 'PREFLIGHT_MODEL_EMPTY_RESPONSE'].includes(error.message)) {
              return incomplete(error.message, trace, modelRounds, toolCalls, outputTokens)
            }
            return incomplete('model_request_failed', trace, modelRounds, toolCalls, outputTokens)
          }

          if (!isValidModelResponse(response)) return incomplete('invalid_model_response', trace, modelRounds, toolCalls, outputTokens)
          if (response.outputTokens > limits.maxOutputTokensPerRound) return incomplete('model_output_limit', trace, modelRounds, toolCalls, outputTokens)
          outputTokens += response.outputTokens
          if (outputTokens > limits.maxTotalOutputTokens) return incomplete('total_output_limit', trace, modelRounds, toolCalls, outputTokens)
          if (response.kind === 'final') return { status: 'complete', value: response.value, trace, modelRounds, toolCalls, outputTokens }

          messages.push({ role: 'assistant', content: { kind: 'tool_calls', calls: response.calls } })
          for (const call of response.calls) {
            if (overallController.signal.aborted) {
              return incomplete(parentSignal.aborted ? 'cancelled' : 'total_timeout', trace, modelRounds, toolCalls, outputTokens)
            }
            const traceItem: TaskPreflightMockTraceItem = {
              kind: 'proposed-tool-call',
              toolName: call.name,
              input: structuredClone(call.input),
              dispatch: 'not-dispatched'
            }
            trace.push(traceItem)
            const adapter = options.mockAdapters[call.name]
            if (!toolNames.has(call.name) || typeof adapter !== 'function') {
              traceItem.dispatch = 'blocked'
              return incomplete('mock_adapter_unavailable', trace, modelRounds, toolCalls, outputTokens)
            }
            if (toolCalls >= limits.maxToolCalls) return incomplete('tool_call_limit', trace.slice(0, -1), modelRounds, toolCalls, outputTokens)

            toolCalls += 1
            traceItem.dispatch = 'simulated'
            try {
              const result = await adapter(call, overallController.signal)
              if (overallController.signal.aborted) {
                return incomplete(parentSignal.aborted ? 'cancelled' : 'total_timeout', trace, modelRounds, toolCalls, outputTokens)
              }
              traceItem.resultKind = result.completeness
              if (result.completeness === 'unavailable') return incomplete('mock_result_unavailable', trace, modelRounds, toolCalls, outputTokens)
              messages.push({ role: 'tool', content: {
                callId: call.id,
                name: call.name,
                result: `[MOCK RESULT — synthetic, not real tool output]\n${result.content}`
              } })
            } catch {
              return incomplete(parentSignal.aborted ? 'cancelled' : 'mock_adapter_failed', trace, modelRounds, toolCalls, outputTokens)
            }
          }
        }

        return incomplete('model_round_limit', trace, modelRounds, toolCalls, outputTokens)
      }

      try {
        return await Promise.race([
          runLoop(),
          totalTimeout,
          cancelled
        ])
      } finally {
        if (totalTimer) clearTimeout(totalTimer)
        overallController.abort()
        parentSignal.removeEventListener('abort', abortFromParent)
        parentSignal.removeEventListener('abort', onParentAbort)
      }
    }
  }
}
