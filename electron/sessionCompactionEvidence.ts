import { createHash } from 'node:crypto'
import type { CompactionReplay } from '../src/shared/compactionEvents'
import { estimateTokensFromUtf8Text } from '../src/shared/contextUsageEstimate'

/** Evidence classification for legacy compaction recovery. This describes facts only; callers choose user-visible recovery behavior. */
export type CompactionRecoveryEvidence = Readonly<{
  checkpointAvailable: boolean
  positiveCompactionEvidence: boolean
  completeDualSourceCoverage: boolean
  replayMetadataComplete: boolean
  estimatedTokens: number
  tokenBudget: number
}>

export type CompactionRecoveryClassification = Readonly<{
  classification: 'checkpoint-available' | 'window-lost-replayable' | 'window-lost-unreplayable' | 'compaction-unknown' | 'never-compressed'
  action: 'use-checkpoint' | 'replay-original' | 'new-split' | 'full-expand'
  budget: 'within-budget' | 'over-budget'
  overBudgetExit?: 'show-context-too-large'
}>

export type LostCompactionRepairEvidence = CompactionRecoveryClassification & Readonly<{
  sourceVersion: string
  lostWindow: Readonly<{ start: string; end: string }>
  lostRanges?: readonly Readonly<{ start: string; end: string }>[]
  branch?: 'replay-original' | 'new-split'
}>

export function isCompactionRepairSourceRevisionCurrent(
  expected: Readonly<{ sessionId: string; generation: string; messageRevision: number }> | undefined,
  current: Readonly<{ sessionId: string; generation: string; messageRevision: number }> | undefined
): boolean {
  return Boolean(expected && current && current.sessionId === expected.sessionId && current.generation === expected.generation &&
    current.messageRevision === expected.messageRevision)
}

/** Derives a conservative repair action from replay facts and the currently available source messages. */
export function inspectLostCompactionRepairEvidence(input: Readonly<{
  replay: CompactionReplay
  messages: readonly Readonly<{ id?: string; content: unknown }>[]
  surfaceIdentities?: readonly string[]
  tokenBudget?: number
}>): LostCompactionRepairEvidence {
  const canonicalize = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)])) : value
  const sourceVersion = createHash('sha256').update(JSON.stringify(canonicalize(input.messages))).digest('hex')
  const hasCheckpoint = input.messages.some(({ content }) => {
    if (content && typeof content === 'object' && !Array.isArray(content)) return (content as { kind?: unknown }).kind === 'context_checkpoint'
    if (typeof content !== 'string') return false
    try { return JSON.parse(content).kind === 'context_checkpoint' } catch { return false }
  })
  const latest = input.replay.committed.at(-1)
  const candidate = latest?.summary.payload.candidate
  const ranges = latest?.summary.payload.shadowedRanges
  const validRanges = Array.isArray(ranges) && ranges.length > 0 && ranges.every((range) => Boolean(range && typeof range === 'object' &&
    typeof (range as { start?: unknown }).start === 'string' && typeof (range as { end?: unknown }).end === 'string'))
  const verifiedRanges = validRanges ? ranges as Array<{ start: string; end: string }> : undefined
  const rangeIdentities = input.surfaceIdentities?.length === input.messages.length
    ? input.surfaceIdentities
    : input.messages.map(({ id }) => id)
  const messageIndices = new Map(rangeIdentities.flatMap((identity, index) => typeof identity === 'string' ? [[identity, index] as const] : []))
  let previousRangeEnd = -1
  const endpointsAvailable = Boolean(verifiedRanges?.every((range) => {
    const start = messageIndices.get(range.start)
    const end = messageIndices.get(range.end)
    if (start === undefined || end === undefined || end < start || start <= previousRangeEnd) return false
    previousRangeEnd = end
    return true
  }))
  const positiveCompactionEvidence = input.replay.committed.length > 0 || input.replay.rejected.some(({ compactionId }) => Boolean(compactionId))
  const classification = classifyCompactionRecoveryEvidence({
    checkpointAvailable: hasCheckpoint,
    positiveCompactionEvidence,
    completeDualSourceCoverage: false,
    replayMetadataComplete: Boolean(latest && latest.start.payload.inputSurfaceFingerprint && validRanges && endpointsAvailable && candidate),
    estimatedTokens: input.messages.reduce((sum, message) => sum + estimateTokensFromUtf8Text(JSON.stringify(message)), 0),
    tokenBudget: input.tokenBudget ?? Number.MAX_SAFE_INTEGER
  })
  const committedRepair = [...input.replay.committed].reverse().find(({ start }) => {
    const repairIdentity = start.payload.repairIdentity
    return Boolean(repairIdentity && typeof repairIdentity === 'object' && !Array.isArray(repairIdentity) &&
      typeof (repairIdentity as { sourceVersion?: unknown }).sourceVersion === 'string' &&
      ((repairIdentity as { branch?: unknown }).branch === 'replay-original' || (repairIdentity as { branch?: unknown }).branch === 'new-split'))
  })
  const committedRepairIdentity = committedRepair?.start.payload.repairIdentity as Record<string, unknown> | undefined
  if (committedRepair && committedRepairIdentity && typeof committedRepairIdentity.windowStart === 'string' && typeof committedRepairIdentity.windowEnd === 'string') {
    const ranges = Array.isArray(committedRepairIdentity.ranges) ? committedRepairIdentity.ranges as Array<{ start: string; end: string }> : undefined
    return Object.freeze({ ...classification, sourceVersion: committedRepairIdentity.sourceVersion as string,
      lostWindow: { start: committedRepairIdentity.windowStart, end: committedRepairIdentity.windowEnd },
      ...(ranges?.length ? { lostRanges: Object.freeze(ranges.map((range) => Object.freeze({ ...range }))) } : {}),
      branch: committedRepairIdentity.branch as 'replay-original' | 'new-split' })
  }
  const lostWindow = verifiedRanges?.length ? { start: verifiedRanges[0]!.start, end: verifiedRanges.at(-1)!.end }
    : { start: `unknown:${latest?.compactionId ?? input.replay.rejected.at(-1)?.compactionId ?? 'unidentified'}`,
    end: `unknown:${latest?.compactionId ?? input.replay.rejected.at(-1)?.compactionId ?? 'unidentified'}` }
  return Object.freeze({ ...classification, sourceVersion, lostWindow,
    ...(classification.action === 'replay-original' && verifiedRanges ? { lostRanges: Object.freeze(verifiedRanges.map((range) => Object.freeze({ ...range }))) } : {}),
    ...(classification.action === 'replay-original' ? { branch: 'replay-original' as const }
      : classification.action === 'new-split' ? { branch: 'new-split' as const } : {}) })
}

export function classifyCompactionRecoveryEvidence(evidence: CompactionRecoveryEvidence): CompactionRecoveryClassification {
  if (!Number.isSafeInteger(evidence.estimatedTokens) || evidence.estimatedTokens < 0 ||
    !Number.isSafeInteger(evidence.tokenBudget) || evidence.tokenBudget < 0) {
    throw new Error('COMPACTION_RECOVERY_BUDGET_INVALID')
  }
  let classification: CompactionRecoveryClassification['classification']
  let action: CompactionRecoveryClassification['action']
  if (evidence.checkpointAvailable) {
    classification = 'checkpoint-available'
    action = 'use-checkpoint'
  } else if (evidence.positiveCompactionEvidence) {
    if (evidence.replayMetadataComplete) {
      classification = 'window-lost-replayable'
      action = 'replay-original'
    } else {
      classification = 'window-lost-unreplayable'
      action = 'new-split'
    }
  } else if (evidence.completeDualSourceCoverage) {
    classification = 'never-compressed'
    action = 'full-expand'
  } else {
    classification = 'compaction-unknown'
    action = 'full-expand'
  }
  const overBudget = evidence.estimatedTokens > evidence.tokenBudget
  return Object.freeze({ classification, action, budget: overBudget ? 'over-budget' : 'within-budget',
    ...(overBudget ? { overBudgetExit: 'show-context-too-large' as const } : {}) })
}
