import type { AgentTurnObserver } from '../../packages/agent-sdk/src/turn'
import type { AssistantFactEvent } from '../../src/shared/assistantFactAggregator'
import { toolIdToOpenAiCompatibleApiToolName } from '../../src/shared/anthropicToolSanitize'
import { normalizeExternalToolName } from '../../src/shared/toolNameCompatibility'
import { sanitizeCapabilityParamsForDisplay } from '../../src/shared/capabilityParamSanitize'
import type { SessionEventInput } from '../sessionEvents'
import type { AgentNotifyEvent } from '../../src/shared/agent/invocation'
import type { FileTreeChangeEvent } from '../../src/shared/fileTreeSync'
import type { ExecutionLane } from '../../src/shared/confirmation/types'
import { buildRequestContextPayload, buildRequestHeaderPayload } from '../../src/shared/requestContext'
import { projectRequestHeaderForWindow } from './requestHeaderProjection'
import { computeContextPressure } from '../../src/shared/contextMeter'
import { projectUsageAfterToolResults, type ContextUsageRaw } from '../../src/shared/contextUsageEstimate'
import { accumulateToolResultVolume, buildStepAttribution, emptyTurnToolDimension, summarizeToolDeclarations, type TurnToolDimension } from '../../src/shared/usageAttribution'

type ObserverChunk = Exclude<import('../../packages/agent-sdk/src/model').StreamChunk, { type: 'finish' }>

function stripUndefinedProperties<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

export function createAgentSdkDesktopObserver(input: {
  requestId: string
  sessionId: string
  turnId: string
  lane?: ExecutionLane
  model?: string
  contextWindow?: number
  windowId?: string
  sessionEventLocation?: { workDir: string; sessionId: string; createdAt: number }
  turnIdForRetry?: string
  stageAssistantContentUntilTurnFinished?: boolean
  onRemoteTextActivity?(text: string): void
  assistantMessageId?: string
  onProviderRetry?(retry: Readonly<{ attempt: number; modelTurn: number; routeId: string; requestId: string; code: string }>): void | Promise<void>
  emitSessionEvent?(event: SessionEventInput): void | Promise<void>
  emitFactEvent?(event: AssistantFactEvent): void
  notify?(event: AgentNotifyEvent): void
  onFileTreeChanged?(event: FileTreeChangeEvent): void
  mapToolResult?(call: { toolCallId: string; toolName: string; input: Record<string, unknown> }, output: unknown, isError: boolean): NonNullable<Extract<AssistantFactEvent, { type: 'tool-result' }>['result']>
  onUsageAttribution?(input: { modelTurn: number; attribution: ReturnType<typeof buildStepAttribution> & { toolDeclarationSnapshot: ReturnType<typeof summarizeToolDeclarations> } }): void
  onTurnToolAttribution?(dimension: TurnToolDimension): void
}): AgentTurnObserver {
  let pendingChunks: ObserverChunk[] = []
  let streamedText = ''
  let streamedThinking = ''
  let hasPreview = false
  let recoveredOutput = false
  const turnToolDimension: TurnToolDimension = emptyTurnToolDimension()
  let activeModelTurn = 0
  let lastAssistantActivityTimestamp = 0
  let newTextSegmentAfterTool = false
  const remoteTextActivityTurns = new Set<number>()
  const requestContexts = new Map<number, {
      requestId: string
      messages: readonly unknown[]
      header: ReturnType<typeof buildRequestHeaderPayload>
      context: ReturnType<typeof buildRequestContextPayload>
    requestHeaderPayload: Record<string, unknown>
    requestContextPayload: Record<string, unknown>
  }>()
  const toolCallStepIds = new Map<string, string>()
  const toolCallActivityTimestamps = new Map<string, number>()
  const nextAssistantActivityTimestamp = () => {
    lastAssistantActivityTimestamp = Math.max(Date.now(), lastAssistantActivityTimestamp + 1)
    return lastAssistantActivityTimestamp
  }
  const toolStepId = (toolCallId: string) => toolCallStepIds.get(toolCallId) ?? input.requestId
  const responseContextProjections = new Map<number, { payload: Record<string, unknown>; projection: ReturnType<typeof computeContextPressure> }>()
  const acceptedToolResponses = new Map<number, {
    usage: Extract<import('../../packages/agent-sdk/src/model').StreamChunk, { type: 'usage' }>
    toolCallIds: ReadonlySet<string>
    request: NonNullable<ReturnType<typeof requestContexts.get>>
  }>()
  const projectedToolUsage = new Map<number, ContextUsageRaw>()
  const stepId = (modelTurn: number) => `${input.requestId}:model:${modelTurn}`
  const emitFact = (event: AssistantFactEvent) => input.emitFactEvent?.(event)
  const emitSessionEvent = (event: SessionEventInput) => input.emitSessionEvent?.({
      ...event,
      payload: {
        ...event.payload,
        requestId: typeof event.payload.requestId === 'string' ? event.payload.requestId : input.requestId,
        invocationRequestId: input.requestId,
        turnId: typeof event.payload.turnId === 'string' ? event.payload.turnId : input.turnId,
        ...(input.lane ? { lane: input.lane } : {})
      }
    })
  const prepareRequestProjection = (request: Parameters<NonNullable<AgentTurnObserver['onModelRequest']>>[0]) => {
    const system = request.request.messages.filter((message) => message.role === 'system').map((message) => typeof message.content === 'string' ? message.content : '').join('\n') || ''
    const canonicalMessages = request.request.messages.filter((message) => message.role !== 'system')
    const requiredMessage = request.requiredUserMessage
    const messages = canonicalMessages.map((message) => message.role === 'user' && requiredMessage && JSON.stringify(message) === JSON.stringify(requiredMessage.message)
      ? { ...message, id: requiredMessage.id }
      : message)
    const requiredSurfaceSet = requiredMessage && messages.some((message) => message.role === 'user' && (message as { id?: string }).id === requiredMessage.id)
      ? [requiredMessage.id]
      : []
    const tools = (request.request.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...(tool.strictSchema === 'require' ? { strict: true } : {})
    }))
    const requestId = `${input.requestId}:round:${request.modelTurn}`
    const header = buildRequestHeaderPayload({
      requestId,
      system,
      tools,
      messages: messages as unknown[],
      requiredSurfaceSet,
      toolExecutionCheckpoint: {
        completedToolUseIds: messages.flatMap((message) => message.role === 'tool' ? [message.toolCallId] : []),
        replayForbidden: false
      }
    })
    let toolResultProjection: ReturnType<typeof computeContextPressure> | undefined
    const previousToolResponse = acceptedToolResponses.get(request.modelTurn - 1)
    const previousRequest = previousToolResponse?.request
    if (previousToolResponse && previousRequest) {
      const toolResults = request.request.messages.filter((message) => message.role === 'tool' && previousToolResponse.toolCallIds.has(message.toolCallId))
      if (toolResults.length > 0) {
        const realUsage: ContextUsageRaw = {
          input_tokens: previousToolResponse.usage.inputTokens,
          output_tokens: previousToolResponse.usage.outputTokens,
          ...(previousToolResponse.usage.cacheReadInputTokens !== undefined ? { cache_read_input_tokens: previousToolResponse.usage.cacheReadInputTokens } : {}),
          ...(previousToolResponse.usage.cacheCreationInputTokens !== undefined ? { cache_creation_input_tokens: previousToolResponse.usage.cacheCreationInputTokens } : {}),
          cacheSemantics: 'additive'
        }
        projectedToolUsage.set(request.modelTurn, projectUsageAfterToolResults(realUsage, toolResults))
        toolResultProjection = computeContextPressure({
          currentSurface: header.surfaceSnapshot,
          anchor: {
            requestId: previousRequest.requestId,
            surfaceTokens: previousRequest.header.surfaceSnapshot.surfaceTokens,
            surfaceFingerprint: previousRequest.header.surfaceSnapshot.fingerprint,
            systemFingerprint: previousRequest.header.surfaceSnapshot.systemFingerprint,
            toolsFingerprint: previousRequest.header.surfaceSnapshot.toolsFingerprint,
            provider: previousRequest.context.provider,
            model: previousRequest.context.model,
            estimatorVersion: previousRequest.context.budget.estimatorVersion,
            serializationVersion: previousRequest.context.budget.serializationVersion,
            realUsage: projectedToolUsage.get(request.modelTurn)!,
            contextWindow: previousRequest.context.contextWindow.tokens
          },
          budget: previousRequest.context.budget,
          decision: { decisionId: requestId, phase: 'tool_loop', reason: 'proactive', ruleVersion: 'adaptive-v1' },
          contextWindow: previousRequest.context.contextWindow,
          provider: previousRequest.context.provider,
          model: previousRequest.context.model
        })
      }
    }
    const windowId = request.windowId ?? input.windowId ?? input.sessionId
    const emittedHeader = projectRequestHeaderForWindow(request.windowId ?? input.windowId ?? input.requestId, header)
    const context = buildRequestContextPayload({
      requestId,
      provider: 'anthropic',
      model: input.model ?? request.routeId,
      contextWindow: input.contextWindow,
      maxTokensEffective: request.request.maxTokens,
      surfaceSnapshot: {
        surfaceTokens: header.surfaceSnapshot.surfaceTokens,
        systemTokens: header.surfaceSnapshot.systemTokens,
        toolsTokens: header.surfaceSnapshot.toolsTokens
      },
      ...(toolResultProjection ? {
        contextUsage: toolResultProjection,
        planningStatus: toolResultProjection.surfaceTokens <= previousRequest!.context.budget.totalInputBudget ? 'fits_without_headroom' : 'exhausted'
      } : {}),
      windowId,
      decision: { decisionId: requestId, phase: 'tool_loop', reason: 'proactive', ruleVersion: 'adaptive-v1' }
    })
    const requestHeaderPayload = { route: 'anthropic.messages.stream', ...emittedHeader, turnId: input.turnId, attempt: request.attempt }
    const requestContextPayload = { ...context, turnId: input.turnId, attempt: request.attempt }
    requestContexts.set(request.modelTurn, { requestId, messages, header, context, requestHeaderPayload, requestContextPayload })
    return {
      ...(input.sessionEventLocation ? { sessionLedger: {
        location: input.sessionEventLocation,
        requestHeader: stripUndefinedProperties({ ...requestHeaderPayload, invocationRequestId: input.requestId, ...(input.lane ? { lane: input.lane } : {}) }),
        requestContext: stripUndefinedProperties({ ...requestContextPayload, invocationRequestId: input.requestId, ...(input.lane ? { lane: input.lane } : {}) })
      } } : {}),
      requestProjection: {
        requestId,
        windowId,
        system,
        tools,
        surfaceSnapshot: header.surfaceSnapshot,
        budget: context.budget,
        contextUsage: toolResultProjection ?? {
          pressureTokens: header.surfaceSnapshot.surfaceTokens,
          projectedTokens: header.surfaceSnapshot.surfaceTokens,
          surfaceTokens: header.surfaceSnapshot.surfaceTokens,
          hardFit: header.surfaceSnapshot.surfaceTokens <= context.budget.totalInputBudget,
          bodyFit: header.surfaceSnapshot.surfaceTokens <= context.budget.totalInputBudget
        },
        toolExecutionCheckpoint: header.toolExecutionCheckpoint,
        requiredSurfaceSet
      }
    }
  }

  const prepareResponseContextProjection = (response: Parameters<NonNullable<AgentTurnObserver['onModelResponseCommitted']>>[0]) => {
    const requestContext = requestContexts.get(response.modelTurn)
    if (!requestContext || response.alreadyProjected) return undefined
    const finalHeader = buildRequestHeaderPayload({
      requestId: requestContext.requestId,
      system: requestContext.header.system ?? '',
      tools: requestContext.header.tools ?? [],
      messages: [...requestContext.messages, response.message],
      requiredSurfaceSet: requestContext.header.requiredSurfaceSet,
      toolExecutionCheckpoint: requestContext.header.toolExecutionCheckpoint
    })
    const usage: ContextUsageRaw = {
      input_tokens: response.usage.inputTokens,
      ...(response.usage.cacheReadInputTokens !== undefined ? { cache_read_input_tokens: response.usage.cacheReadInputTokens } : {}),
      ...(response.usage.cacheCreationInputTokens !== undefined ? { cache_creation_input_tokens: response.usage.cacheCreationInputTokens } : {}),
      cacheSemantics: 'additive'
    }
    const contextWindow = requestContext.context.contextWindow
    const projection = computeContextPressure({
      currentSurface: finalHeader.surfaceSnapshot,
      anchor: {
        requestId: requestContext.requestId,
        surfaceTokens: requestContext.header.surfaceSnapshot.surfaceTokens,
        surfaceFingerprint: requestContext.header.surfaceSnapshot.fingerprint,
        systemFingerprint: requestContext.header.surfaceSnapshot.systemFingerprint,
        toolsFingerprint: requestContext.header.surfaceSnapshot.toolsFingerprint,
        provider: requestContext.context.provider,
        model: requestContext.context.model,
        estimatorVersion: requestContext.context.budget.estimatorVersion,
        serializationVersion: requestContext.context.budget.serializationVersion,
        realUsage: usage,
        contextWindow: contextWindow.tokens
      },
      budget: requestContext.context.budget,
      decision: { decisionId: requestContext.requestId, phase: 'tool_loop', reason: 'proactive', ruleVersion: 'adaptive-v1' },
      contextWindow,
      provider: requestContext.context.provider,
      model: requestContext.context.model
    })
    const payload = buildRequestContextPayload({
      requestId: requestContext.requestId,
      provider: requestContext.context.provider,
      model: requestContext.context.model,
      contextWindow: contextWindow.tokens,
      maxTokensEffective: requestContext.context.maxTokensEffective,
      surfaceSnapshot: finalHeader.surfaceSnapshot,
      contextUsage: projection,
      planningStatus: projection.surfaceTokens <= requestContext.context.budget.totalInputBudget ? 'fits_without_headroom' : 'exhausted',
      windowId: requestContext.context.windowId,
      decision: { decisionId: requestContext.requestId, phase: 'tool_loop', reason: 'proactive', ruleVersion: 'adaptive-v1' }
    })
    const finalPayload = stripUndefinedProperties({
      ...payload, turnId: input.turnId, attempt: requestContexts.get(response.modelTurn)?.requestContextPayload.attempt ?? 1,
      invocationRequestId: input.requestId, ...(input.lane ? { lane: input.lane } : {}), projectionStage: 'final' as const
    })
    responseContextProjections.set(response.modelTurn, { payload: finalPayload, projection })
    return {
      ...finalPayload,
      turnBoundaryProjection: {
        requestId: requestContext.requestId,
        windowId: requestContext.context.windowId,
        system: requestContext.header.system ?? '',
        tools: requestContext.header.tools ?? [],
        surfaceSnapshot: finalHeader.surfaceSnapshot,
        budget: requestContext.context.budget,
        contextUsage: {
          pressureTokens: projection.pressureTokens,
          projectedTokens: projection.projectedTokens,
          surfaceTokens: projection.surfaceTokens,
          hardFit: projection.hardFit,
          bodyFit: projection.bodyFit
        },
        toolExecutionCheckpoint: requestContext.header.toolExecutionCheckpoint,
        requiredSurfaceSet: requestContext.header.requiredSurfaceSet
      }
    }
  }

  return {
    criticalModelRequestProjection: true,
    criticalModelResponseProjection: true,
    criticalModelAttemptUsageProjection: true,
    criticalToolProjection: true,
    prepareUsageAttribution({ modelTurn, request }) {
      const system = request.messages.filter((message) => message.role === 'system').map((message) => typeof message.content === 'string' ? message.content : '').join('\n')
      const messages = request.messages.filter((message) => message.role !== 'system')
      const tools = (request.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema, ...(tool.strictSchema === 'require' ? { strict: true } : {}) }))
      const attribution = { ...buildStepAttribution({ system, tools, messages }), toolDeclarationSnapshot: summarizeToolDeclarations(tools) }
      input.onUsageAttribution?.({ modelTurn, attribution })
      return attribution
    },
    async prepareProviderRetry(retry) {
      return input.sessionEventLocation ? {
        location: input.sessionEventLocation,
        requestRetry: {
          turnId: input.turnIdForRetry ?? input.turnId,
          stepId: input.requestId,
          requestId: retry.requestId,
          attempt: retry.attempt,
          backoffMs: 0,
          code: retry.code
        }
      } : undefined
    },
    async onProviderRetry(retry) { await input.onProviderRetry?.(retry) },
    async onModelAttemptDiscarded() {
      if (hasPreview) emitFact({ type: 'preview-rollback' })
      for (const chunk of pendingChunks) if (chunk.type === 'tool-call') toolCallActivityTimestamps.delete(chunk.toolCallId)
      pendingChunks = []
      streamedText = ''
      streamedThinking = ''
      newTextSegmentAfterTool = false
      hasPreview = false
    },
    async prepareModelResponseProjection(response) {
      const payload = prepareResponseContextProjection(response)
      if (!payload) return undefined
      const { turnBoundaryProjection, ...requestContextPayload } = payload
      return {
        ...(input.sessionEventLocation ? { sessionLedger: { location: input.sessionEventLocation, requestContext: requestContextPayload } } : {}),
        ...(turnBoundaryProjection ? { turnBoundaryProjection } : {})
      }
    },
    prepareModelRequest(request) { return prepareRequestProjection(request) },
    async onOutputRecovery(recovery) {
      recoveredOutput = true
      for (const call of recovery.toolCalls) {
        const outbox = recovery.sessionLedgerEvents.find((event) => event.kind === 'tool-call-not-dispatched' && (event.payload as { toolCallId?: unknown }).toolCallId === call.toolCallId)
        const sidecar = (outbox?.payload as { sessionLedger?: { result?: unknown } } | undefined)?.sessionLedger?.result
        const userMessage = recovery.toolCallErrorContent
        const result = sidecar && typeof sidecar === 'object' && !Array.isArray(sidecar) && typeof (sidecar as { success?: unknown }).success === 'boolean'
          ? sidecar as Extract<AssistantFactEvent, { type: 'tool-result' }>['result']
          : { success: false, error: 'model_output_token_limit', userMessage, notExecuted: true as const, notExecutedReason: 'model_output_truncated' as const }
        await emitSessionEvent({ type: 'tool_result', payload: { turnId: input.turnId, stepId: toolStepId(call.toolCallId), toolUseId: call.toolCallId, result } })
        emitFact({ type: 'tool-result', id: call.toolCallId, result })
      }
      if (recovery.willRetry) {
        const outbox = recovery.sessionLedgerEvents.find((event) => event.kind === 'provider-retry-scheduled' && (event.payload as { requestId?: unknown }).requestId === recovery.requestId)
        const retry = (outbox?.payload as { sessionLedger?: { requestRetry?: unknown } } | undefined)?.sessionLedger?.requestRetry
        await emitSessionEvent({ type: 'request_retry', payload: retry && typeof retry === 'object' && !Array.isArray(retry)
          ? retry as Record<string, unknown>
          : { turnId: input.turnId, stepId: input.requestId, requestId: recovery.requestId, attempt: recovery.attempt, backoffMs: 0, code: 'model_output_token_limit' } })
      }
    },
    async onModelRequest(request) {
      activeModelTurn = request.modelTurn
      const prepared = requestContexts.get(request.modelTurn) ?? (prepareRequestProjection(request), requestContexts.get(request.modelTurn)!)
      const projectedUsage = projectedToolUsage.get(request.modelTurn)
      if (projectedUsage) emitFact({ type: 'usage-updated', usage: projectedUsage, projected: true })
      await emitSessionEvent({ type: 'request_header', payload: prepared.requestHeaderPayload })
      await emitSessionEvent({ type: 'request_context', payload: prepared.requestContextPayload })
    },
    async onModelChunk(chunk) {
      pendingChunks.push(structuredClone(chunk))
      if (chunk.type === 'text-delta') {
        streamedText += chunk.text
        if (input.stageAssistantContentUntilTurnFinished && chunk.text.trim() && !remoteTextActivityTurns.has(activeModelTurn)) {
          remoteTextActivityTurns.add(activeModelTurn)
          input.onRemoteTextActivity?.(chunk.text)
        }
        if (chunk.text && !input.stageAssistantContentUntilTurnFinished) {
          emitFact({ type: 'content-delta', text: chunk.text, sourceTimestamp: nextAssistantActivityTimestamp(), ...(newTextSegmentAfterTool ? { newSegment: true } : {}) })
          newTextSegmentAfterTool = false
          hasPreview = true
        }
      } else if (chunk.type === 'thinking-delta') {
        streamedThinking += chunk.text
        if (chunk.text && !input.stageAssistantContentUntilTurnFinished) {
          emitFact({ type: 'thinking-delta', text: chunk.text, sourceTimestamp: nextAssistantActivityTimestamp() })
          hasPreview = true
        }
      } else if (chunk.type === 'tool-call') {
        toolCallActivityTimestamps.set(chunk.toolCallId, nextAssistantActivityTimestamp())
        newTextSegmentAfterTool = true
      }
    },
    async onModelResponseCommitted(response) {
      if (!response.alreadyProjected && response.message.role === 'assistant' && response.message.toolCalls?.length) {
        const request = requestContexts.get(response.modelTurn)
        if (!request) throw new Error(`missing request projection for model turn ${response.modelTurn}`)
        acceptedToolResponses.set(response.modelTurn, {
          usage: response.usage,
          toolCallIds: new Set(response.message.toolCalls.map((call) => call.id)),
          request
        })
      }
      if (response.alreadyProjected) {
        const calls = response.message.role === 'assistant' ? response.message.toolCalls ?? [] : []
        const committedStepId = response.committedStepId ?? stepId(response.modelTurn)
        for (const call of calls) toolCallStepIds.set(call.id, committedStepId)
      }
      const chunks = pendingChunks
      pendingChunks = []
      if (response.alreadyProjected) {
        streamedText = ''
        streamedThinking = ''
        hasPreview = false
        return
      }
      const requestContext = requestContexts.get(response.modelTurn)
      if (requestContext) {
        const prepared = responseContextProjections.get(response.modelTurn) ?? (() => {
          prepareResponseContextProjection(response)
          return responseContextProjections.get(response.modelTurn)
        })()
        if (prepared) {
          emitFact({ type: 'context-projection-updated', projection: prepared.projection })
          await emitSessionEvent({ type: 'request_context', payload: prepared.payload })
        }
        requestContexts.delete(response.modelTurn)
        responseContextProjections.delete(response.modelTurn)
      }
      const events: SessionEventInput[] = []
      const toolCallEvents: SessionEventInput[] = []
      let nextBlockIndex = 0
      let activeBlock: { type: 'text' | 'thinking'; index: number } | undefined
      const pushDelta = (delta: Record<string, unknown>) => events.push({ type: 'assistant_chunk', payload: { turnId: input.turnId, stepId: stepId(response.modelTurn), messageId: input.assistantMessageId, delta } })
      const closeActiveBlock = () => {
        if (!activeBlock) return
        pushDelta({ type: 'block_end', index: activeBlock.index })
        activeBlock = undefined
      }
      for (const chunk of chunks) {
        if (chunk.type === 'text-delta' || chunk.type === 'thinking-delta') {
          const type = chunk.type === 'text-delta' ? 'text' : 'thinking'
          if (activeBlock?.type !== type) {
            closeActiveBlock()
            activeBlock = { type, index: nextBlockIndex++ }
            pushDelta({ type: 'block_start', index: activeBlock.index, blockType: type })
          }
          pushDelta(chunk.type === 'text-delta'
            ? { type: 'text_delta', index: activeBlock.index, text: chunk.text }
            : { type: 'reasoning_delta', index: activeBlock.index, text: chunk.text })
        }
        else if (chunk.type === 'tool-call') {
          closeActiveBlock()
          const index = nextBlockIndex++
          const compatName = toolIdToOpenAiCompatibleApiToolName(normalizeExternalToolName(chunk.toolName).canonicalName)
          pushDelta({ type: 'block_start', index, blockType: 'tool_use', id: chunk.toolCallId, name: compatName })
          // The old stream ledger retained the tool delta envelope but stripped raw JSON before persistence.
          pushDelta({ type: 'tool_call_delta', index, partialJson: '' })
          pushDelta({ type: 'block_end', index })
          const isToolkitCall = compatName === 'toolkit_call' || compatName === 'toolkit.call'
          const args = structuredClone(chunk.input)
          toolCallEvents.push({ type: 'tool_call', payload: { turnId: input.turnId, stepId: stepId(response.modelTurn), toolUseId: chunk.toolCallId, name: compatName, args: isToolkitCall ? sanitizeCapabilityParamsForDisplay(args) : args } })
        }
        else if (chunk.type === 'usage') pushDelta({ type: 'usage', usage: { input_tokens: chunk.inputTokens, output_tokens: chunk.outputTokens, ...(chunk.cacheReadInputTokens !== undefined ? { cache_read_input_tokens: chunk.cacheReadInputTokens } : {}), ...(chunk.cacheCreationInputTokens !== undefined ? { cache_creation_input_tokens: chunk.cacheCreationInputTokens } : {}) } })
      }
      closeActiveBlock()
      const stopReason = response.finishReason === 'tool-calls' ? 'tool_use' : response.finishReason === 'length' ? 'max_tokens' : 'end_turn'
      pushDelta({ type: 'finish', stopReason })
      for (const event of events) await emitSessionEvent(event)
      for (const event of toolCallEvents) await emitSessionEvent(event)
      const committedBlocks = response.message.role === 'assistant' && Array.isArray(response.message.content) ? response.message.content : []
      if (!input.stageAssistantContentUntilTurnFinished) {
        const committedText = committedBlocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
        const committedThinking = committedBlocks.filter((block) => block.type === 'thinking').map((block) => block.thinking).join('')
        if (streamedText !== committedText && committedText) emitFact({ type: 'content-reconciled', text: committedText })
        if (streamedThinking !== committedThinking && committedThinking) emitFact({ type: 'thinking-reconciled', text: committedThinking })
      }
      const committedToolCalls = response.message.role === 'assistant' ? response.message.toolCalls ?? [] : []
      for (const call of committedToolCalls) {
        toolCallStepIds.set(call.id, stepId(response.modelTurn))
        const compatName = toolIdToOpenAiCompatibleApiToolName(normalizeExternalToolName(call.name).canonicalName)
        const sourceTimestamp = toolCallActivityTimestamps.get(call.id)
        emitFact({ type: 'tool-use', id: call.id, toolName: compatName, input: structuredClone(call.input), ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}) })
        toolCallActivityTimestamps.delete(call.id)
      }
      if (!input.stageAssistantContentUntilTurnFinished) emitFact({ type: 'preview-commit' })
      streamedText = ''
      streamedThinking = ''
      newTextSegmentAfterTool = false
      hasPreview = false
    },
    async onToolStarted() {},
    async onToolFinished(call, result) {
      const toolName = normalizeExternalToolName(call.toolName).canonicalName
      accumulateToolResultVolume(turnToolDimension, toolName, result.output)
      const isError = result.isError ?? false
      const output = result.output && typeof result.output === 'object' && !Array.isArray(result.output)
        ? result.output as Record<string, unknown>
        : undefined
      const projected = input.mapToolResult?.(call, result.output, isError) ?? ({
        success: typeof output?.success === 'boolean' ? output.success : !isError,
        ...((typeof output?.error === 'string' || isError) ? { error: typeof output?.error === 'string' ? output.error : String(result.output ?? 'tool failed') } : {}),
        ...(typeof output?.userMessage === 'string' ? { userMessage: output.userMessage } : {}),
        ...('data' in (output ?? {}) ? { data: output!.data } : { data: result.output })
      } as never)
      if (result.auditRef && projected && typeof projected === 'object') projected.auditRef = result.auditRef
      await emitSessionEvent({ type: 'tool_result', payload: { turnId: input.turnId, stepId: toolStepId(call.toolCallId), toolUseId: call.toolCallId, result: projected } })
      emitFact({ type: 'tool-result', id: call.toolCallId, result: projected })
      if (projected.success) {
        const toolName = normalizeExternalToolName(call.toolName).canonicalName
        if ((toolName === 'write_file' || toolName === 'edit_file') && typeof call.input.path === 'string' && call.input.path.trim()) {
          input.onFileTreeChanged?.({ kind: 'paths', relPaths: [call.input.path.trim()] })
        } else if (toolName === 'run_shell' || toolName === 'run_script') {
          input.onFileTreeChanged?.({ kind: 'refreshExpanded' })
        }
      }
      input.notify?.({ kind: 'tool-result', requestId: input.requestId, toolUseId: call.toolCallId })
    },
    async onTurnOutputReady(result) {
      if (input.stageAssistantContentUntilTurnFinished || recoveredOutput) emitFact({ type: 'content-reconciled', text: result.text })
    },
    async onTurnFinished() {
      input.onTurnToolAttribution?.(structuredClone(turnToolDimension))
      recoveredOutput = false
      hasPreview = false
    },
    async onTurnFailed() {
      if (hasPreview) emitFact({ type: 'preview-rollback' })
      recoveredOutput = false
      hasPreview = false
      pendingChunks = []
      toolCallActivityTimestamps.clear()
      newTextSegmentAfterTool = false
    }
  }
}
