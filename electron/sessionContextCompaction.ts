import { createHash, randomUUID } from 'node:crypto'
import { estimateTokensFromUtf8Text } from '../src/shared/contextUsageEstimate'
import { computeReplaySurfaceFingerprint, excludeReplayOnlyMessages, projectReplaySurface, surfaceItemIdentities, surfaceItemIdentitiesForSubset } from '../src/shared/surfaceReplay'
import { computeCompactionSummaryHash } from '../src/shared/compactionEvents'
import { planUserCompactionSurface } from '../src/shared/turnBoundaryCompaction'
import type { ContextFrame, ContextTransformationProof, JsonValue, SessionContextAdapter } from '../packages/agent-sdk/src/context'
import { safeSummaryContentText } from '../src/shared/safeSummaryText'
import type { CompactionReplay } from '../src/shared/compactionEvents'

export type SessionContextSurfaceMessage = { id?: string; role: 'user' | 'assistant'; content: unknown; [key: string]: unknown }
type SurfaceMessage = SessionContextSurfaceMessage

/** Stable identity for a lost-compaction repair; retries of the same source/window/branch must address the same commit. */
export function createLostCompactionRepairId(input: Readonly<{
  sessionId: string
  sourceVersion: string
  lostWindow: Readonly<{ start: string; end: string }>
  lostRanges?: readonly Readonly<{ start: string; end: string }>[]
  branch: 'replay-original' | 'new-split'
}>): string {
  if (!input.sessionId.trim() || !input.sourceVersion.trim() || !input.lostWindow.start.trim() || !input.lostWindow.end.trim()) {
    throw new Error('LOST_COMPACTION_REPAIR_IDENTITY_INCOMPLETE')
  }
  const identity = JSON.stringify([input.sessionId, input.sourceVersion, input.lostWindow.start, input.lostWindow.end,
    input.lostRanges ?? [], input.branch])
  return `lost-compaction-repair:${input.sessionId}:${createHash('sha256').update(identity).digest('hex')}`
}

export type SessionContextCompactionResult =
  | { status: 'committed'; compactionId: string; windowId: string; outputSurfaceFingerprint: string; repairBranch?: 'replay-original' | 'new-split' }
  | { status: 'no-op' | 'uncompressible' | 'busy' | 'failed' | 'stale' | 'cancel' | 'commit-uncertain' }

export function lostCompactionRepairFallback(
  branch: LostCompactionRepair['branch'] | undefined,
  result: SessionContextCompactionResult
): SessionContextCompactionResult | { status: 'context-too-large'; fallback: 'full-expand' } {
  if (branch === 'new-split' && (result.status === 'failed' || result.status === 'uncompressible')) {
    return { status: 'context-too-large', fallback: 'full-expand' }
  }
  return result
}

export type LostCompactionRepair = Readonly<{
  sourceVersion: string
  lostWindow: Readonly<{ start: string; end: string }>
  lostRanges?: readonly Readonly<{ start: string; end: string }>[]
  branch: 'replay-original' | 'new-split'
  replay: CompactionReplay
}>


export type SessionContextSummary = { task: string; completed: string; decisions: string; constraints: string; pending: string; blockers: string; nextStep: string }
export type SessionContextSummaryInput = readonly { role: SurfaceMessage['role']; content: string }[]
export type SessionContextRecoveryFacts = Readonly<{
  unresolvedEffects: readonly Readonly<{ id: string; originInvocationId: string; toolCallId: string }>[]
  toolOutcomes: readonly Readonly<{ id: string; toolName?: string; outcome: 'succeeded' | 'known-failure' | 'unknown-after-dispatch' | 'not-dispatched' }>[]
}>

export function createSessionContextCheckpointMessage(id: string, summary: SessionContextSummary, recoveryFacts: SessionContextRecoveryFacts = { unresolvedEffects: [], toolOutcomes: [] }) {
  return {
    id,
    role: 'user' as const,
    content: JSON.stringify({
      kind: 'context_checkpoint', ...summary,
      unresolvedEffectIds: recoveryFacts.unresolvedEffects.map(({ id: effectId }) => effectId),
      toolOutcomes: recoveryFacts.toolOutcomes.slice(-20)
    })
  }
}

export function isSessionContextCheckpointWorthCompacting(message: { content: unknown }, shadowedTokenCount: number): boolean {
  return estimateTokensFromUtf8Text(JSON.stringify(message)) < shadowedTokenCount
}

function textOf(message: SurfaceMessage): string {
  return safeSummaryContentText(message.content)
}

export async function compactSessionContext(input: {
  sessionId: string
  requestId: string
  windowId: string
  messages: readonly SurfaceMessage[]
  totalInputBudget: number
  locale: 'zh-CN' | 'en-US'
  contextAdapter: SessionContextAdapter
  repair?: LostCompactionRepair
  signal?: AbortSignal
  recoveryFacts?: SessionContextRecoveryFacts
  summarize: (messages: SessionContextSummaryInput, locale: 'zh-CN' | 'en-US', recoveryFacts?: SessionContextRecoveryFacts, signal?: AbortSignal) => Promise<SessionContextSummary>
}): Promise<SessionContextCompactionResult> {
  try {
    if (input.signal?.aborted) return { status: 'cancel' }
    const repairId = input.repair ? createLostCompactionRepairId({ sessionId: input.sessionId,
      sourceVersion: input.repair.sourceVersion, lostWindow: input.repair.lostWindow, lostRanges: input.repair.lostRanges,
      branch: input.repair.branch }) : undefined
    if (repairId && input.repair) {
      const committedRepair = input.repair.replay.committed.find(({ compactionId }) => compactionId === repairId)
      if (committedRepair) {
        const start = committedRepair.start.payload
        const summary = committedRepair.summary.payload
        const identity = start.repairIdentity as Record<string, unknown> | undefined
        if (!identity || identity.sourceVersion !== input.repair.sourceVersion || identity.branch !== input.repair.branch ||
          identity.windowStart !== input.repair.lostWindow.start || identity.windowEnd !== input.repair.lostWindow.end ||
          JSON.stringify(identity.ranges ?? []) !== JSON.stringify(input.repair.lostRanges ?? [])) return { status: 'failed' }
        const outputSurfaceFingerprint = summary.outputSurfaceFingerprint
        const windowId = committedRepair.end.payload.outputWindowId ?? committedRepair.end.payload.windowId
        if (typeof outputSurfaceFingerprint !== 'string' || typeof windowId !== 'string') return { status: 'failed' }
        return { status: 'committed', compactionId: repairId, windowId, outputSurfaceFingerprint, repairBranch: input.repair.branch }
      }
    }
    const contextBase = await input.contextAdapter.port.readCurrent({ kind: 'session', sessionId: input.sessionId })
    const replayMessages = projectReplaySurface(excludeReplayOnlyMessages(input.messages, [])) as SurfaceMessage[]
    if (computeReplaySurfaceFingerprint('', contextBase.frame.items.map((item) => item.message)) !== computeReplaySurfaceFingerprint('', replayMessages)) return { status: 'stale' }
    if (replayMessages.length < 3) return { status: 'no-op' }
    const identities = surfaceItemIdentities(replayMessages)
    const newestUser = [...replayMessages].reverse().find((message) => message.role === 'user')
    const newestAssistant = [...replayMessages].reverse().find((message) => message.role === 'assistant')
    const requiredIds = new Set([newestUser, newestAssistant].filter((message): message is SurfaceMessage => Boolean(message)).map((message) => identities[replayMessages.indexOf(message)]!))
    const items = replayMessages.map((message, index) => ({ id: identities[index]!, tokens: estimateTokensFromUtf8Text(JSON.stringify(message)), required: requiredIds.has(identities[index]!) }))
    const checkpointId = repairId ? `checkpoint:${repairId}` : `checkpoint:${input.sessionId}:${input.requestId}`
    const checkpointMessage = { id: checkpointId, role: 'user' as const, content: '' }
    const checkpointPlanningTokens = estimateTokensFromUtf8Text(JSON.stringify({ kind: 'context_checkpoint', task: '', decisions: '', pending: '' }))
    const plan = planUserCompactionSurface({ items, checkpointId, checkpointTokens: checkpointPlanningTokens, totalInputBudget: input.totalInputBudget })
    let record = plan.record
    if (plan.status === 'uncompressible' || plan.actions.some((action) => action.status === 'uncompressible')) return { status: 'uncompressible' }
    if (input.repair?.branch === 'replay-original') {
      const ranges = input.repair.lostRanges ?? [input.repair.lostWindow]
      const verifiedRanges: Array<{ start: string; end: string }> = []
      for (const range of ranges) {
        const start = items.findIndex(({ id }) => id === range.start)
        const end = items.findIndex(({ id }) => id === range.end)
        if (start < 0 || end < start || (verifiedRanges.length > 0 && start <= items.findIndex(({ id }) => id === verifiedRanges.at(-1)!.end)) ||
          items.slice(start, end + 1).some(({ required }) => required)) return { status: 'failed' }
        verifiedRanges.push({ start: range.start, end: range.end })
      }
      record = { checkpointId, shadowedRanges: verifiedRanges }
    }
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
      content: JSON.stringify({ kind: 'context_checkpoint', task: 'x', completed: 'x', decisions: 'x', constraints: 'x', pending: 'x', blockers: 'x', nextStep: 'x', unresolvedEffectIds: [], toolOutcomes: [] })
    }
    if (estimateTokensFromUtf8Text(JSON.stringify(minimumCheckpoint)) >= shadowedTokenCount) return { status: 'no-op' }
    if (input.signal?.aborted) return { status: 'cancel' }
    const checkpointSummary = await input.summarize(shadowSource.map((message) => ({ role: message.role, content: textOf(message) })), input.locale, input.recoveryFacts, input.signal)
    if (input.signal?.aborted) return { status: 'cancel' }
    if (!checkpointSummary || !['task', 'completed', 'decisions', 'constraints', 'pending', 'blockers', 'nextStep'].every((key) => {
      const value = checkpointSummary[key as keyof SessionContextSummary]
      return typeof value === 'string' && Boolean(value.trim()) && value.length <= 2_000
    })) return { status: 'failed' }
    checkpointMessage.content = createSessionContextCheckpointMessage(checkpointId, checkpointSummary, input.recoveryFacts).content
    const checkpointTokens = estimateTokensFromUtf8Text(JSON.stringify(checkpointMessage))
    if (checkpointTokens >= shadowedTokenCount) return { status: 'no-op' }
    const retainedTokens = items.filter((item) => !shadowedIds.has(item.id)).reduce((sum, item) => sum + item.tokens, 0)
    if (checkpointTokens + retainedTokens > input.totalInputBudget) return { status: 'uncompressible' }
    const outputMessages = [checkpointMessage, ...replayMessages.filter((_message, index) => !shadowedIds.has(identities[index]!))]
    const outputIdentities = surfaceItemIdentitiesForSubset(replayMessages, outputMessages)
    const outputSurfaceFingerprint = computeReplaySurfaceFingerprint('', outputMessages)
    const inputSurfaceFingerprint = computeReplaySurfaceFingerprint('', replayMessages)
    const compactionId = repairId ?? `user-compact:${input.sessionId}:${input.requestId}:${randomUUID()}`
    const candidate = { kind: 'summary' as const, checkpointMessage, checkpointReplayIdentity: outputIdentities[0], shadowedRanges: record.shadowedRanges }
    const repairIdentity = input.repair ? { sourceVersion: input.repair.sourceVersion, branch: input.repair.branch,
      windowStart: input.repair.lostWindow.start, windowEnd: input.repair.lostWindow.end,
      ranges: input.repair.lostRanges ?? [] } : undefined
    const start = { compactionId, windowId: input.windowId, inputSurfaceFingerprint, surfaceBoundaryId: identities.at(-1), targetTokens: 0,
      reason: input.repair ? 'lost_compaction_repair' : 'user_compact', sourceRequestId: input.requestId,
      ...(input.repair ? { repairMarker: input.repair.branch === 'new-split' ? 'repair:new-split' : 'repair:original-window' } : {}),
      ...(repairIdentity ? { repairIdentity } : {}) }
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
      if (input.signal?.aborted) return { status: 'cancel' }
      const registered = input.contextAdapter.registerTransformation({ base, output, proof })
      const committed = await input.contextAdapter.port.commitReplacement({ operationId: compactionId, reason: 'manual-compact', candidate: registered })
      if (committed.status === 'stale' || committed.status === 'busy' || committed.status === 'no-op' || committed.status === 'uncompressible') return { status: committed.status }
      if (committed.status === 'commit-uncertain') return { status: 'commit-uncertain' }
    }
    return { status: 'committed', compactionId, windowId: input.windowId, outputSurfaceFingerprint,
      ...(input.repair ? { repairBranch: input.repair.branch } : {}) }
  } catch {
    return input.signal?.aborted ? { status: 'cancel' } : { status: 'failed' }
  }
}
