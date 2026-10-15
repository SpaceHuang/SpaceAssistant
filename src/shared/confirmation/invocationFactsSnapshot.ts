import type { ContentFacts } from './types'

export type FactCompleteness = 'complete' | 'partial' | 'missing' | 'parse-failed' | 'authentication-missing' | 'capability-description-stale'

export interface InvocationFactsSnapshot {
  readonly factId: string
  readonly invocationId: string
  readonly envelopeHash: string
  readonly factsHash: string
  readonly extractorVersion: string
  readonly completeness: FactCompleteness
  readonly evidenceReferences: readonly string[]
  readonly environmentVersion: string
  readonly policyVersion: string
  readonly factsRevision: number
  readonly facts: Readonly<ContentFacts>
}

/** Shared ToolFacts contract: keep ContentFacts as the sole domain payload and bind it once here. */
export type ToolFacts = InvocationFactsSnapshot

export interface CreateInvocationFactsSnapshotInput {
  invocationId: string
  envelope: unknown
  facts: ContentFacts
  extractorVersion: string
  completeness: FactCompleteness
  evidenceReferences: readonly string[]
  environmentVersion: string
  policyVersion?: string
  factsRevision?: number
  previousFactsRevision: number
}

function stableJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('Snapshot contains a cycle')
    seen.add(value)
    const result = `[${value.map((entry) => stableJson(entry, seen)).join(',')}]`
    seen.delete(value)
    return result
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw new Error('Snapshot contains a cycle')
    seen.add(value)
    const record = value as Record<string, unknown>
    const entries = Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(record[key], seen)}`)
    const result = `{${entries.join(',')}}`
    seen.delete(value)
    return result
  }
  throw new Error('Snapshot contains a non-JSON value')
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

/** Bind trusted extractor output to one invocation and the exact environment in which it was derived. */
export async function createInvocationFactsSnapshot(input: CreateInvocationFactsSnapshotInput): Promise<InvocationFactsSnapshot> {
  if (typeof input.invocationId !== 'string' || !input.invocationId.trim()) throw new Error('invocationId is required')
  if (typeof input.extractorVersion !== 'string' || !input.extractorVersion.trim()) throw new Error('extractorVersion is required')
  if (typeof input.environmentVersion !== 'string' || !input.environmentVersion.trim()) throw new Error('environmentVersion is required')
  if (input.policyVersion !== undefined && (typeof input.policyVersion !== 'string' || !input.policyVersion.trim())) throw new Error('policyVersion is invalid')
  if (!['complete', 'partial', 'missing', 'parse-failed', 'authentication-missing', 'capability-description-stale'].includes(input.completeness)) {
    throw new Error('facts completeness is invalid')
  }
  if (!Number.isSafeInteger(input.previousFactsRevision) || input.previousFactsRevision < 0 || input.previousFactsRevision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('previous facts revision is invalid')
  }
  if (!Array.isArray(input.evidenceReferences) || input.evidenceReferences.some((ref) => typeof ref !== 'string' || !ref.trim())) {
    throw new Error('evidence references are invalid')
  }
  const envelopeJson = stableJson(input.envelope)
  const factsJson = stableJson(input.facts)
  const facts = JSON.parse(factsJson) as ContentFacts
  const envelopeHash = await sha256(envelopeJson)
  const factsHash = await sha256(factsJson)
  const factsRevision = input.factsRevision ?? (input.previousFactsRevision + 1)
  if (!Number.isSafeInteger(factsRevision) || factsRevision < 1) throw new Error('facts revision is invalid')
  const policyVersion = input.policyVersion ?? 'policy-unspecified'
  const factId = `fact-${(await sha256(stableJson({ invocationId: input.invocationId, envelopeHash, factsHash,
    extractorVersion: input.extractorVersion, completeness: input.completeness, environmentVersion: input.environmentVersion,
    policyVersion, factsRevision }))).slice(0, 24)}`
  return deepFreeze({
    factId,
    invocationId: input.invocationId,
    envelopeHash,
    factsHash,
    extractorVersion: input.extractorVersion,
    completeness: input.completeness,
    evidenceReferences: [...input.evidenceReferences],
    environmentVersion: input.environmentVersion,
    policyVersion,
    factsRevision,
    facts
  })
}

export function sameInvocationFactsSnapshot(left: InvocationFactsSnapshot, right: InvocationFactsSnapshot): boolean {
  return left.factId === right.factId && left.invocationId === right.invocationId && left.envelopeHash === right.envelopeHash &&
    left.factsHash === right.factsHash && left.extractorVersion === right.extractorVersion &&
    left.completeness === right.completeness && left.environmentVersion === right.environmentVersion &&
    left.policyVersion === right.policyVersion &&
    left.factsRevision === right.factsRevision &&
    stableJson(left.evidenceReferences) === stableJson(right.evidenceReferences)
}

export function serializeInvocationFactsSnapshot(snapshot: InvocationFactsSnapshot): string {
  return stableJson(snapshot)
}
