import { describe, expect, it } from 'vitest'
import { shouldRetainReferenceArtifact } from './referenceRetention'

describe('shouldRetainReferenceArtifact', () => {
  it('does not create an artifact or Git decision for ordinary retrieval and short summaries', () => {
    expect(shouldRetainReferenceArtifact({ mode: 'retrieve' })).toBe(false)
    expect(shouldRetainReferenceArtifact({ mode: 'short-summary' })).toBe(false)
  })
})
