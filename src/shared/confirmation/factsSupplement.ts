import {
  createInvocationFactsSnapshot,
  type FactCompleteness,
  type InvocationFactsSnapshot
} from './invocationFactsSnapshot'
import type { FactSignal } from './types'

export interface VerifiedEvidence {
  signals: readonly FactSignal[]
  /** Optional completeness proven by the host while resolving this reference. */
  completeness?: FactCompleteness
}

export interface VerifyAndCreateFactsSupplementInput {
  prior: InvocationFactsSnapshot
  envelope: unknown
  /** Model-provided pointers only; this function never accepts model-authored fact payloads. */
  requestedReferences: readonly string[]
  round: number
  deadlineAt: number
  now: () => number
  environmentVersion?: string
  resolveEvidence: (reference: string) => Promise<VerifiedEvidence | undefined> | VerifiedEvidence | undefined
  maxRounds?: number
}

/** Resolve model evidence leads through trusted host code and create a new monotonic snapshot. */
export async function verifyAndCreateFactsSupplement(
  input: VerifyAndCreateFactsSupplementInput
): Promise<InvocationFactsSnapshot> {
  const maxRounds = input.maxRounds ?? 3
  if (!Number.isSafeInteger(input.round) || input.round < 1 || input.round > maxRounds) {
    throw new Error('FACTS_SUPPLEMENT_ROUND_LIMIT')
  }
  if (!Number.isSafeInteger(input.deadlineAt) || typeof input.now !== 'function' || input.now() >= input.deadlineAt) {
    throw new Error('FACTS_SUPPLEMENT_DEADLINE_EXCEEDED')
  }
  if (!Array.isArray(input.requestedReferences) || input.requestedReferences.length === 0 || input.requestedReferences.length > 8 ||
      input.requestedReferences.some((reference) => typeof reference !== 'string' || !reference.trim()) ||
      new Set(input.requestedReferences).size !== input.requestedReferences.length) {
    throw new Error('FACTS_SUPPLEMENT_REFERENCES_INVALID')
  }

  const verifiedSignals: FactSignal[] = []
  const verifiedCompleteness: FactCompleteness[] = []
  for (const reference of input.requestedReferences) {
    if (input.now() >= input.deadlineAt) throw new Error('FACTS_SUPPLEMENT_DEADLINE_EXCEEDED')
    const verified = await input.resolveEvidence(reference)
    if (input.now() >= input.deadlineAt) throw new Error('FACTS_SUPPLEMENT_DEADLINE_EXCEEDED')
    if (!verified || !Array.isArray(verified.signals)) throw new Error('FACTS_SUPPLEMENT_EVIDENCE_UNVERIFIED')
    if (verified.completeness !== undefined) {
      if (!['complete', 'partial', 'missing', 'parse-failed', 'authentication-missing', 'capability-description-stale'].includes(verified.completeness)) {
        throw new Error('FACTS_SUPPLEMENT_COMPLETENESS_INVALID')
      }
      verifiedCompleteness.push(verified.completeness)
    }
    verifiedSignals.push(...verified.signals)
  }

  const facts = {
    ...input.prior.facts,
    // Prior signals are monotonic: a supplement can add verified evidence, never erase risk.
    signals: [...input.prior.facts.signals, ...verifiedSignals]
  }
  const completenessOrder: FactCompleteness[] = [
    'complete', 'partial', 'missing', 'authentication-missing', 'capability-description-stale', 'parse-failed'
  ]
  const completeness = verifiedCompleteness.length > 0
    ? verifiedCompleteness.reduce((mostConservative, candidate) =>
      completenessOrder.indexOf(candidate) > completenessOrder.indexOf(mostConservative) ? candidate : mostConservative)
    : input.prior.completeness
  const next = await createInvocationFactsSnapshot({
    invocationId: input.prior.invocationId,
    envelope: input.envelope,
    facts,
    extractorVersion: input.prior.extractorVersion,
    completeness,
    evidenceReferences: [...new Set([...input.prior.evidenceReferences, ...input.requestedReferences])],
    environmentVersion: input.environmentVersion ?? input.prior.environmentVersion,
    policyVersion: input.prior.policyVersion,
    previousFactsRevision: input.prior.factsRevision
  })
  if (next.envelopeHash !== input.prior.envelopeHash) throw new Error('FACTS_SUPPLEMENT_ENVELOPE_CHANGED')
  return next
}
