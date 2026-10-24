import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'
import { searchVerifiedChatBodyPayload } from './projectionChatBodyCachePayload'

function payloadFor(messages: readonly unknown[]) {
  const sessionId = 'search-session'
  const sessionGeneration = 'search-generation'
  const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
  const sourceIdentityJson = JSON.stringify({ historyWatermark: { sessionSeq: 3 } })
  const bytes = Buffer.from(JSON.stringify({ formatVersion: 1, scopeKey, specVersion: 3, sessionId, sessionGeneration,
    sourceIdentityJson, historyWatermarkJson: { sessionSeq: 3 }, messages }))
  const payloadDigest = createHash('sha256').update(bytes).digest('hex')
  return { payload: bytes, sessionId, sessionGeneration, scopeKey, specVersion: 3, sourceIdentityJson, payloadDigest,
    validatedRangeJson: JSON.stringify({ formatVersion: 1, specVersion: 3, sourceIdentityJson, fromSequence: 0,
      payloadDigest, blobByteLength: bytes.byteLength }) }
}

describe('prepared chat body global search', () => {
  it('returns only literal SQLite LIKE matches in timestamp order, with ASCII-only case folding', () => {
    const payload = payloadFor([
      { id: 'older', role: 'user', content: 'Needle 100%_x', timestamp: 1 },
      { id: 'newer', role: 'assistant', content: 'needle 100%_x', timestamp: 3 },
      { id: 'wrong-case', role: 'user', content: 'NEEDLE 100%_x', timestamp: 4 },
      { id: 'wildcard-only', role: 'user', content: 'needle 100abc_x', timestamp: 5 },
      { id: 'non-ascii', role: 'user', content: 'Äneedle 100%_x', timestamp: 6 }
    ])

    const result = searchVerifiedChatBodyPayload({ ...payload, query: 'needle 100%_x', limit: 10 })

    expect(result.map(({ id }) => id)).toEqual(['non-ascii', 'wrong-case', 'newer', 'older'])
    expect(result.map(({ content }) => content)).toEqual([
      'Äneedle 100%_x', 'NEEDLE 100%_x', 'needle 100%_x', 'Needle 100%_x'
    ])
    const nonAsciiCase = payloadFor([
      { id: 'lower', role: 'user', content: 'äneedle', timestamp: 1 }
    ])
    expect(searchVerifiedChatBodyPayload({ ...nonAsciiCase, query: 'Äneedle', limit: 10 })).toEqual([])
  })

  it('applies a bounded result limit after ordering matches', () => {
    const payload = payloadFor([
      { id: 'old', role: 'user', content: 'match', timestamp: 1 },
      { id: 'new', role: 'assistant', content: 'match', timestamp: 2 }
    ])

    expect(searchVerifiedChatBodyPayload({ ...payload, query: 'match', limit: 1 }).map(({ id }) => id)).toEqual(['new'])
  })
})
