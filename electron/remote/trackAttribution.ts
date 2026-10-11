import { isRemoteTrackPricingEvidence } from '../../src/shared/remoteTrackPricingEvidence'

export type TrackCandidateSummary = {
  trackId: string
  state: 'open' | 'processing' | 'waiting-user' | 'waiting-async-approval' | 'resuming' | 'completed'
  summary: string
  updatedAt: number
}

export type IntentAttributorResult =
  | { kind: 'scores'; scores: Array<{ trackId: string; score: number }>; metering?: IntentAttributorMetering }
  | { kind: 'unavailable'; reasonCode: 'timeout' | 'provider-error' | 'invalid-output'; metering?: IntentAttributorMetering }

export type IntentAttributorMetering = Readonly<{
  providerCallMade: boolean
  inputTokens: number | null
  outputTokens: number | null
  cacheReadInputTokens: number | null
  cacheCreationInputTokens: number | null
  estimatedCostUsd: number | null
  pricingEvidence?: Readonly<{ sourceUrl: string; effectiveAt: string; verifiedAt: string; verifiedBy: string }>
}>

/** The classifier receives only the normalized current message and bounded Track summaries. */
export interface IntentAttributor {
  readonly classifierVersion?: string
  classify(input: { text: string; candidates: TrackCandidateSummary[]; deadlineMs: number; signal?: AbortSignal }): Promise<IntentAttributorResult>
}

export type RemoteAttributionDecision =
  | { kind: 'new-track'; reasonCode: string }
  | { kind: 'continuation'; trackId: string; confidence: number; evidenceCodes: string[] }
  | { kind: 'successor'; parentTrackId: string; confidence: number; evidenceCodes: string[] }
  | { kind: 'ambiguous'; candidateTrackIds: string[]; reasonCode: string }
  | { kind: 'rejected'; reasonCode: string }
  | { kind: 'reserved-protocol'; protocol: 'confirmation' | 'clarification' }

type ExplicitReference = {
  trackId: string
  state: TrackCandidateSummary['state'] | 'cancelled' | 'expired' | 'failed' | 'unavailable'
}

type AttributionInput = {
  text: string
  candidates: TrackCandidateSummary[]
  classifier: IntentAttributor
  messageKind?: 'ordinary' | 'confirmation' | 'clarification'
  explicitReference?: ExplicitReference
  classifierDeadlineMs?: number
}

export const REMOTE_TRACK_ATTRIBUTION_POLICY_VERSION = 'remote-intent-v1'
export const REMOTE_TRACK_CONTINUATION_SCORE_THRESHOLD = 0.85
export const REMOTE_TRACK_CONTINUATION_SCORE_MARGIN = 0.15
const MAX_CLASSIFIER_CANDIDATES = 5
const DEFAULT_CLASSIFIER_DEADLINE_MS = 2000
const ACTIVE_TRACK_STATES = new Set(['open', 'processing', 'waiting-user', 'waiting-async-approval', 'resuming'])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function validMetering(metering: unknown): metering is IntentAttributorMetering {
  const baseKeys = ['providerCallMade', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'estimatedCostUsd']
  if (!isPlainRecord(metering) || (!hasExactKeys(metering, baseKeys) && !hasExactKeys(metering, [...baseKeys, 'pricingEvidence'])) ||
    typeof metering.providerCallMade !== 'boolean') return false
  if (['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'estimatedCostUsd']
    .some((key) => metering[key] !== null && (typeof metering[key] !== 'number' || !Number.isFinite(metering[key]) || (metering[key] as number) < 0))) return false
  if (!Object.hasOwn(metering, 'pricingEvidence')) return true
  return isRemoteTrackPricingEvidence(metering.pricingEvidence)
}

function hasOptionalMetering(value: Record<string, unknown>, baseKeys: string[]): boolean {
  if (hasExactKeys(value, baseKeys)) return true
  return hasExactKeys(value, [...baseKeys, 'metering']) && validMetering(value.metering)
}

function invalidScores(result: unknown, candidates: TrackCandidateSummary[]): boolean {
  if (!isPlainRecord(result) || result.kind !== 'scores' || !Array.isArray(result.scores) || !hasOptionalMetering(result, ['kind', 'scores'])) return true
  if (result.scores.length !== candidates.length) return true
  const allowed = new Set(candidates.map(({ trackId }) => trackId))
  const seen = new Set<string>()
  for (const entry of result.scores) {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, ['trackId', 'score'])) return true
    if (typeof entry.trackId !== 'string' || !allowed.has(entry.trackId) || seen.has(entry.trackId)) return true
    if (typeof entry.score !== 'number' || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 1) return true
    seen.add(entry.trackId)
  }
  return seen.size !== allowed.size
}

function withDeadline<T>(promise: Promise<T>, deadlineMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error('track classifier deadline exceeded'))
    }, deadlineMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

function ambiguous(candidates: TrackCandidateSummary[], reasonCode: string): RemoteAttributionDecision {
  return { kind: 'ambiguous', candidateTrackIds: candidates.map(({ trackId }) => trackId), reasonCode }
}

export async function attributeRemoteMessage(input: AttributionInput): Promise<RemoteAttributionDecision> {
  const messageKind = input.messageKind ?? 'ordinary'
  if (messageKind === 'confirmation' || messageKind === 'clarification') {
    return { kind: 'reserved-protocol', protocol: messageKind }
  }

  if (input.explicitReference) {
    const reference = input.explicitReference
    if (reference.state === 'unavailable' || reference.state === 'cancelled' || reference.state === 'expired' || reference.state === 'failed') {
      return { kind: 'rejected', reasonCode: 'explicit-reference-unavailable' }
    }
    if (reference.state === 'completed') {
      return { kind: 'successor', parentTrackId: reference.trackId, confidence: 1, evidenceCodes: ['explicit-platform-reference'] }
    }
    return { kind: 'continuation', trackId: reference.trackId, confidence: 1, evidenceCodes: ['explicit-platform-reference'] }
  }

  const candidates = input.candidates
  if (candidates.length === 0) return { kind: 'new-track', reasonCode: 'no-eligible-candidates' }
  if (candidates.length > MAX_CLASSIFIER_CANDIDATES) return ambiguous(candidates, 'too-many-candidates')

  const deadlineMs = input.classifierDeadlineMs ?? DEFAULT_CLASSIFIER_DEADLINE_MS
  let rawResult: unknown
  try {
    const controller = new AbortController()
    rawResult = await withDeadline(input.classifier.classify({ text: input.text, candidates, deadlineMs, signal: controller.signal }),
      deadlineMs, () => controller.abort())
  } catch (error) {
    return ambiguous(candidates, error instanceof Error && error.message === 'track classifier deadline exceeded'
      ? 'classifier-timeout'
      : 'classifier-unavailable')
  }

  if (isPlainRecord(rawResult) && rawResult.kind === 'unavailable' && hasOptionalMetering(rawResult, ['kind', 'reasonCode']) &&
    ['timeout', 'provider-error', 'invalid-output'].includes(String(rawResult.reasonCode))) {
    return ambiguous(candidates, `classifier-${rawResult.reasonCode}`)
  }
  if (invalidScores(rawResult, candidates)) return ambiguous(candidates, 'classifier-invalid-output')

  const ranked = [...(rawResult as Extract<IntentAttributorResult, { kind: 'scores' }>).scores]
    .sort((left, right) => right.score - left.score)
  const best = ranked[0]
  const margin = best.score - (ranked[1]?.score ?? 0)
  if (best.score < REMOTE_TRACK_CONTINUATION_SCORE_THRESHOLD) {
    return { kind: 'new-track', reasonCode: 'no-reasonable-continuation-candidate' }
  }
  if (margin < REMOTE_TRACK_CONTINUATION_SCORE_MARGIN) return ambiguous(candidates, 'confidence-margin-too-small')

  const candidate = candidates.find(({ trackId }) => trackId === best.trackId)!
  const evidenceCodes = ['semantic-unique-above-threshold']
  if (candidate.state === 'completed') {
    return { kind: 'successor', parentTrackId: candidate.trackId, confidence: best.score, evidenceCodes }
  }
  if (!ACTIVE_TRACK_STATES.has(candidate.state)) return { kind: 'rejected', reasonCode: 'candidate-state-not-continuable' }
  return { kind: 'continuation', trackId: candidate.trackId, confidence: best.score, evidenceCodes }
}
