import { describe, expect, it } from 'vitest'
import { resolveReferenceRetention, shouldRetainReferenceArtifact } from './referenceRetention'

describe('shouldRetainReferenceArtifact', () => {
  it('does not create an artifact or Git decision for ordinary retrieval and short summaries', () => {
    expect(shouldRetainReferenceArtifact({ mode: 'retrieve' })).toBe(false)
    expect(shouldRetainReferenceArtifact({ mode: 'short-summary' })).toBe(false)
  })

  it('asks long-term/pending/cancel for an unassociated local save request', () => {
    expect(resolveReferenceRetention({ mode: 'save' })).toEqual({
      kind: 'reference-retention', choices: ['long-term', 'pending', 'cancel']
    })
  })
})
