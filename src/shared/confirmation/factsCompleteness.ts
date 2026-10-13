import type { FactCompleteness } from './invocationFactsSnapshot'

export type FactsCompletenessDecision =
  | { completeness: 'complete'; disposition: 'evaluate' }
  | { completeness: 'partial' | 'missing' | 'authentication-missing' | 'capability-description-stale'; disposition: 'human-required' }
  | { completeness: 'parse-failed'; disposition: 'forbidden' }

const COMPLETENESS_DECISIONS: Readonly<Record<FactCompleteness, FactsCompletenessDecision>> = {
  complete: { completeness: 'complete', disposition: 'evaluate' },
  partial: { completeness: 'partial', disposition: 'human-required' },
  missing: { completeness: 'missing', disposition: 'human-required' },
  'parse-failed': { completeness: 'parse-failed', disposition: 'forbidden' },
  'authentication-missing': { completeness: 'authentication-missing', disposition: 'human-required' },
  'capability-description-stale': { completeness: 'capability-description-stale', disposition: 'human-required' }
}

/** Convert extraction completeness into a closed security outcome; unknown states never imply read-only. */
export function resolveFactsCompleteness(input: unknown): FactsCompletenessDecision {
  if (typeof input !== 'string' || !Object.hasOwn(COMPLETENESS_DECISIONS, input)) {
    throw new Error('FACTS_COMPLETENESS_UNSUPPORTED')
  }
  return COMPLETENESS_DECISIONS[input as FactCompleteness]
}
