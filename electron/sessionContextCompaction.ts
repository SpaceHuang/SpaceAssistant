import { randomUUID } from 'node:crypto'
import { estimateTokensFromUtf8Text } from '../src/shared/contextUsageEstimate'
import { computeReplaySurfaceFingerprint, excludeReplayOnlyMessages, projectReplaySurface, surfaceItemIdentities, surfaceItemIdentitiesForSubset } from '../src/shared/surfaceReplay'
import { computeCompactionSummaryHash } from '../src/shared/compactionEvents'
import { planUserCompactionSurface } from '../src/shared/turnBoundaryCompaction'
import type { ContextFrame, ContextTransformationProof, JsonValue, SessionContextAdapter } from '../packages/agent-sdk/src/context'

export type SessionContextSurfaceMessage = { id?: string; role: 'user' | 'assistant'; content: unknown; [key: string]: unknown }
type SurfaceMessage = SessionContextSurfaceMessage
export type SessionContextCompactionResult =
  | { status: 'committed'; compactionId: string; windowId: string; outputSurfaceFingerprint: string }
  | { status: 'no-op' | 'uncompressible' | 'busy' | 'failed' | 'stale' }

function safeSummaryContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeSummaryContent)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.type === 'image' || record.type === 'image_url') return { type: record.type, note: 'image payload omitted from text summary' }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [
      key,
      ['data', 'base64', 'bytes'].includes(key.toLowerCase()) ? '[binary payload omitted]' : safeSummaryContent(item)
    ]))
  }
  return value
}

export type SessionContextSummary = { task: string; decisions: string; pending: string }
export type SessionContextSummaryInput = readonly { role: SurfaceMessage['role']; content: string }[]

function textOf(message: SurfaceMessage): string {
  if (typeof message.content === 'string') return message.content
  return JSON.stringify(safeSummaryContent(message.content)) ?? ''
}

export async function compactSessionContext(input: {
  sessionId: string
  requestId: string
  windowId: string
  messages: readonly SurfaceMessage[]
  totalInputBudget: number
  locale: 'zh-CN' | 'en-US'
  contextAdapter: SessionContextAdapter
  summarize: (messages: SessionContextSummaryInput, locale: 'zh-CN' | 'en-US') => Promise<SessionContextSummary>
}): Promise<SessionContextCompactionResult> {
  try {
    const contextBase = await input.contextAdapter.port.readCurrent({ kind: 'session', sessionId: input.sessionId })
    const replayMessages = projectReplaySurface(excludeReplayOnlyMessages(input.messages, [])) as SurfaceMessage[]
    if (computeReplaySurfaceFingerprint('', contextBase.frame.items.map((item) => item.message)) !== computeReplaySurfaceFingerprint('', replayMessages)) return { status: 'stale' }
    if (replayMessages.length < 3) return { status: 'no-op' }
    const identities = surfaceItemIdentities(replayMessages)
    const newestUser = [...replayMessages].reverse().find((message) => message.role === 'user')
    const newestAssistant = [...replayMessages].reverse().find((message) => message.role === 'assistant')
    const requiredIds = new Set([newestUser, newestAssistant].filter((message): message is SurfaceMessage => Boolean(message)).map((message) => identities[replayMessages.indexOf(message)]!))
    const items = replayMessages.map((message, index) => ({ id: identities[index]!, tokens: estimateTokensFromUtf8Text(JSON.stringify(message)), required: requiredIds.has(identities[index]!) }))
    const checkpointId = `checkpoint:${input.sessionId}:${input.requestId}`
    const checkpointMessage = { id: checkpointId, role: 'user' as const, content: '' }
    const checkpointPlanningTokens = estimateTokensFromUtf8Text(JSON.stringify({ kind: 'context_checkpoint', task: '', decisions: '', pending: '' }))
    const plan = planUserCompactionSurface({ items, checkpointId, checkpointTokens: checkpointPlanningTokens, totalInputBudget: input.totalInputBudget })
    const record = plan.record
    if (plan.status === 'uncompressible' || plan.actions.some((action) => action.status === 'uncompressible')) return { status: 'uncompressible' }
    if (!record || !record.shadowedRanges.length) return { status: 'no-op' }

    const shadowedIds = new Set(record.shadowedRanges.flatMap((range) => {
      const start = items.findIndex((item) => item.id === range.start)
      const end = items.findIndex((item) => item.id === range.end)
      return start >= 0 && end >= start ? items.slice(start, end + 1).map((item) => item.id) : []
    }))
    const shadowSource = replayMessages.filter((_message, index) => shadowedIds.has(identities[index]!))
    const shadowedTokenCount = items.filter((item) => shadowedIds.has(item.id)).reduce((sum, item) => sum + item.tokens, 0)
    const minimumCheckpoint = {
      id: checkpointId,
      role: 'user' as const,
      content: JSON.stringify({ kind: 'context_checkpoint', task: 'x', decisions: 'x', pending: 'x' })
    }
    if (estimateTokensFromUtf8Text(JSON.stringify(minimumCheckpoint)) >= shadowedTokenCount) return { status: 'no-op' }
    const checkpointSummary = await input.summarize(shadowSource.map((message) => ({ role: message.role, content: textOf(message) })), input.locale)
    if (!checkpointSummary || !['task', 'decisions', 'pending'].every((key) => {
      const value = checkpointSummary[key as keyof SessionContextSummary]
      return typeof value === 'string' && Boolean(value.trim()) && value.length <= 2_000
    })) return { status: 'failed' }
    checkpointMessage.content = JSON.stringify({ kind: 'context_checkpoint', ...checkpointSummary })
    const checkpointTokens = estimateTokensFromUtf8Text(JSON.stringify(checkpointMessage))
    if (checkpointTokens >= shadowedTokenCount) return { status: 'no-op' }
    const retainedTokens = items.filter((item) => !shadowedIds.has(item.id)).reduce((sum, item) => sum + item.tokens, 0)
    if (checkpointTokens + retainedTokens > input.totalInputBudget) return { status: 'uncompressible' }
    const outputMessages = [checkpointMessage, ...replayMessages.filter((_message, index) => !shadowedIds.has(identities[index]!))]
    const outputIdentities = surfaceItemIdentitiesForSubset(replayMessages, outputMessages)
    const outputSurfaceFingerprint = computeReplaySurfaceFingerprint('', outputMessages)
    const inputSurfaceFingerprint = computeReplaySurfaceFingerprint('', replayMessages)
    const compactionId = `user-compact:${input.sessionId}:${input.requestId}:${randomUUID()}`
    const candidate = { kind: 'summary' as const, checkpointMessage, checkpointReplayIdentity: outputIdentities[0], shadowedRanges: record.shadowedRanges }
    const start = { compactionId, windowId: input.windowId, inputSurfaceFingerprint, surfaceBoundaryId: identities.at(-1), targetTokens: 0, reason: 'user_compact', sourceRequestId: input.requestId }
    const summary = { compactionId, windowId: input.windowId, summaryHash: computeCompactionSummaryHash(candidate), outputSurfaceFingerprint, shadowedRanges: record.shadowedRanges, candidate }
    {
      const base = contextBase
      const baseByIdentity = new Map(base.frame.items.map((item) => [item.replayIdentity, item]))
      const checkpointIdentity = outputIdentities[0]!
      const outputItems = outputMessages.map((message, index) => {
        const identity = outputIdentities[index]!
        const prior = baseByIdentity.get(identity)
        return prior ?? { replayIdentity: identity, sourceMessageIds: [], message: message as import('../packages/agent-sdk/src/model').CanonicalModelMessage, sourceData: {} }
      })
      const output: ContextFrame = { ...base.frame, windowId: input.windowId, items: outputItems }
      const sourceBindings = outputItems.map((item) => ({
        outputIdentity: item.replayIdentity,
        inputIdentities: item.sourceMessageIds.length ? [item.replayIdentity] : []
      }))
      const proof: ContextTransformationProof = {
        historyPayload: { compactionId, windowId: input.windowId, inputSurfaceFingerprint, outputSurfaceFingerprint, summaryHash: summary.summaryHash, candidate, start: JSON.parse(JSON.stringify(start)) as JsonValue, summary },
        sourceBindings,
        checkpoint: { identity: checkpointIdentity, checkpointMessage },
        shadowedRanges: record.shadowedRanges
      }
      const registered = input.contextAdapter.registerTransformation({ base, output, proof })
      const committed = await input.contextAdapter.port.commitReplacement({ operationId: compactionId, reason: 'manual-compact', candidate: registered })
      if (committed.status === 'stale' || committed.status === 'busy' || committed.status === 'no-op' || committed.status === 'uncompressible') return { status: committed.status }
      if (committed.status === 'commit-uncertain') return { status: 'failed' }
    }
    return { status: 'committed', compactionId, windowId: input.windowId, outputSurfaceFingerprint }
  } catch {
    return { status: 'failed' }
  }
}
