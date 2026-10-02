export type SpillKind = 'source-of-truth' | 'degradable'

export type SpillPayloadFacts = Readonly<{
  /** The payload is required to rebuild an invocation, resume execution, or construct provider context. */
  requiredForRecovery: boolean
  /** Canonical history can rebuild the exact logical payload if this stored copy disappears. */
  canonicalEquivalent: boolean
  /** The canonical event transaction committed a locator for the durable external payload. */
  canonicalLocatorCommitted: boolean
  /** The payload is complete and has not been replaced by an omission/truncation marker. */
  payloadComplete: boolean
  /** A configured retention policy may delete this payload. */
  retentionAllowed: boolean
}>

export type SpillPolicy = Readonly<{
  kind: SpillKind
  readFailure: 'hard-fail' | 'placeholder'
  retention: 'never' | 'allowed'
}>

/**
 * Classify by recovery semantics, never by payload size or storage path. A
 * degradable spill is safe only when canonical history can reproduce it exactly.
 */
export function classifySpillPayload(facts: SpillPayloadFacts): SpillPolicy {
  if (facts.requiredForRecovery) {
    if (facts.retentionAllowed) throw new Error('recovery-required spill cannot have a retention period')
    if (!facts.payloadComplete) throw new Error('source-of-truth spill requires complete payload')
    if (!facts.canonicalLocatorCommitted) throw new Error('source-of-truth spill requires canonical locator commitment')
    return { kind: 'source-of-truth', readFailure: 'hard-fail', retention: 'never' }
  }
  if (!facts.canonicalEquivalent) throw new Error('degradable spill must be reconstructible from canonical history')
  return { kind: 'degradable', readFailure: 'placeholder', retention: facts.retentionAllowed ? 'allowed' : 'never' }
}
