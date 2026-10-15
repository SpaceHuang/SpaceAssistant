import { resolveFactsCompleteness } from './factsCompleteness'
import {
  createInvocationFactsSnapshot,
  sameInvocationFactsSnapshot,
  type FactCompleteness,
  type InvocationFactsSnapshot
} from './invocationFactsSnapshot'
import type { ContentFacts } from './types'
import type { Decision, ExecutionContext, PolicyEngineDeps, PolicyRule } from './types'
import { decide } from '../policy/policyEngine'

export interface RecheckInvocationFactsInput {
  prior: InvocationFactsSnapshot
  envelope: unknown
  facts: ContentFacts
  extractorVersion: string
  completeness: FactCompleteness
  evidenceReferences: readonly string[]
  environmentVersion: string
  policyVersion?: string
}

export type RecheckInvocationFactsResult =
  | { status: 'current'; snapshot: InvocationFactsSnapshot }
  | { status: 'redecide'; snapshot: InvocationFactsSnapshot }
  | { status: 'human-required'; completeness: Exclude<FactCompleteness, 'complete' | 'parse-failed'> }
  | { status: 'hard-deny'; completeness: 'parse-failed' }

export interface RedecideSupplementedInvocationInput {
  snapshot: InvocationFactsSnapshot
  context: ExecutionContext
  rules: PolicyRule[]
  deps: PolicyEngineDeps
}

/** Re-run the complete current policy chain against a verified snapshot, without stale cache decisions. */
export function redecideSupplementedInvocation(input: RedecideSupplementedInvocationInput): Decision {
  const completeness = resolveFactsCompleteness(input.snapshot.completeness)
  if (completeness.disposition === 'forbidden') {
    return {
      type: 'deny', ruleId: 'facts-parse-failed', reason: 'Facts extraction failed',
      disposition: 'forbidden', cause: 'parse-failed'
    }
  }
  if (completeness.disposition === 'human-required') {
    return {
      type: 'require-confirm', ruleId: 'facts-incomplete', answerer: 'user', riskLevel: input.snapshot.facts.baseRiskLevel,
      facts: input.snapshot.facts, memoryTiers: [], timeoutMs: null, disposition: 'human-required',
      cause: completeness.completeness, reason: 'Current invocation facts are incomplete'
    }
  }

  return decide(input.snapshot.facts, input.context, input.rules, {
    ...input.deps,
    // A prior allow/deny cache is a decision about another facts revision and cannot survive supplementation.
    cache: { lookup: () => null }
  })
}

export interface FencedInvocationDecision {
  readonly invocationId: string
  readonly factsRevision: number
  readonly factsHash: string
  readonly envelopeHash: string
  readonly environmentVersion: string
  readonly policyVersion: string
  readonly decision: Decision
}

/** Validate the immutable snapshot fingerprint, then bind the fresh decision to that exact local revision. */
export async function redecideAndFenceSupplementedInvocation(
  input: RedecideSupplementedInvocationInput
): Promise<FencedInvocationDecision> {
  const { snapshot } = input
  if (!Number.isSafeInteger(snapshot.factsRevision) || snapshot.factsRevision < 1) {
    throw new Error('INVOCATION_FACTS_SNAPSHOT_INVALID')
  }
  const verified = await createInvocationFactsSnapshot({
    invocationId: snapshot.invocationId,
    // The canonical envelope is intentionally not retained in a facts snapshot. Its
    // already-verified digest stays opaque; recompute the facts digest independently.
    envelope: null,
    facts: snapshot.facts,
    extractorVersion: snapshot.extractorVersion,
    completeness: snapshot.completeness,
    evidenceReferences: snapshot.evidenceReferences,
    environmentVersion: snapshot.environmentVersion,
    policyVersion: snapshot.policyVersion,
    previousFactsRevision: snapshot.factsRevision - 1
  })
  if (verified.factsHash !== snapshot.factsHash || !snapshot.envelopeHash ||
      !snapshot.environmentVersion || !snapshot.policyVersion || !snapshot.extractorVersion ||
      !Array.isArray(snapshot.evidenceReferences)) {
    throw new Error('INVOCATION_FACTS_SNAPSHOT_FINGERPRINT_MISMATCH')
  }
  return {
    invocationId: snapshot.invocationId,
    factsRevision: snapshot.factsRevision,
    factsHash: snapshot.factsHash,
    envelopeHash: snapshot.envelopeHash,
    environmentVersion: snapshot.environmentVersion,
    policyVersion: snapshot.policyVersion,
    decision: redecideSupplementedInvocation(input)
  }
}

/** Re-extract facts before dispatch; this pure component never creates todos or executes tools. */
export async function recheckInvocationFactsSnapshot(
  input: RecheckInvocationFactsInput
): Promise<RecheckInvocationFactsResult> {
  const completeness = resolveFactsCompleteness(input.completeness)
  if (completeness.disposition === 'human-required') {
    return { status: 'human-required', completeness: completeness.completeness }
  }
  if (completeness.disposition === 'forbidden') {
    return { status: 'hard-deny', completeness: completeness.completeness }
  }

  const candidate = await createInvocationFactsSnapshot({
    invocationId: input.prior.invocationId,
    envelope: input.envelope,
    facts: input.facts,
    extractorVersion: input.extractorVersion,
    completeness: input.completeness,
    evidenceReferences: input.evidenceReferences,
    environmentVersion: input.environmentVersion,
    policyVersion: input.policyVersion ?? input.prior.policyVersion,
    previousFactsRevision: Math.max(0, input.prior.factsRevision - 1)
  })
  if (sameInvocationFactsSnapshot(input.prior, candidate)) return { status: 'current', snapshot: input.prior }

  const next = await createInvocationFactsSnapshot({
    invocationId: input.prior.invocationId,
    envelope: input.envelope,
    facts: input.facts,
    extractorVersion: input.extractorVersion,
    completeness: input.completeness,
    evidenceReferences: input.evidenceReferences,
    environmentVersion: input.environmentVersion,
    policyVersion: input.policyVersion ?? input.prior.policyVersion,
    previousFactsRevision: input.prior.factsRevision
  })
  return { status: 'redecide', snapshot: next }
}
