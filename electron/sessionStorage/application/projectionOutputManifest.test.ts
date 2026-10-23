import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { materializeProjectionOutputManifest } from './projectionOutputManifest'

const identity = { sessionId: 's1', sessionGeneration: 'g1', scopeKey: 'chatBodyV1', specVersion: 1, sourceIdentityJson: '{"revision":1}' }
function blob(locator: string, parent: unknown, operations: unknown[]) {
  const payload = JSON.stringify({ formatVersion: 2, ...identity, outputManifest: { formatVersion: 1, parent, operations } })
  return { locator, payload, byteLength: Buffer.byteLength(payload), payloadDigest: createHash('sha256').update(payload).digest('hex') }
}

describe('projection output manifest materializer', () => {
  it('applies append and replace deltas from oldest to newest after each blob is verified', async () => {
    const first = blob('first', null, [{ type: 'append', messages: [{ role: 'user', id: 'u1', content: 'old' }] }])
    const second = blob('second', { locator: first.locator, byteLength: first.byteLength, payloadDigest: first.payloadDigest }, [
      { type: 'append', messages: [{ role: 'assistant', id: 'a1', content: 'answer' }] },
      { type: 'replace', messages: [{ role: 'user', id: 'u2', content: 'compacted' }] },
      { type: 'append', messages: [{ role: 'assistant', id: 'a2', content: 'new answer' }] },
    ])
    const reads: string[] = []
    const result = await materializeProjectionOutputManifest(second, identity, { readVerified: async ({ locator, byteLength, payloadDigest }) => {
      reads.push(locator)
      const node = locator === 'first' ? first : second
      if (byteLength !== node.byteLength || payloadDigest !== node.payloadDigest) throw new Error('blob mismatch')
      return node.payload
    } })
    expect(reads).toEqual(['second', 'first'])
    expect(result).toEqual([{ role: 'user', id: 'u2', content: 'compacted' }, { role: 'assistant', id: 'a2', content: 'new answer' }])
  })

  it('appends assistant text chunks to an existing stable message identity', async () => {
    const first = blob('chunk-first', null, [{ type: 'append', messages: [{ role: 'assistant', id: 'a1', content: 'partial' }] }])
    const second = blob('chunk-second', { locator: first.locator, byteLength: first.byteLength, payloadDigest: first.payloadDigest }, [
      { type: 'appendText', updates: [{ role: 'assistant', id: 'a1', text: ' response' }] },
    ])
    await expect(materializeProjectionOutputManifest(second, identity, { readVerified: async ({ locator }) =>
      locator === 'chunk-first' ? first.payload : second.payload })).resolves.toEqual([
      { role: 'assistant', id: 'a1', content: 'partial response' },
    ])
    const invalid = blob('chunk-invalid', null, [{ type: 'appendText', updates: [{ role: 'assistant', id: 'missing', text: 'x' }] }])
    await expect(materializeProjectionOutputManifest(invalid, identity, { readVerified: async () => invalid.payload }))
      .rejects.toThrow('PROJECTION_OUTPUT_TEXT_APPEND_TARGET_INVALID')
  })

  it('rejects cross-source, cyclic, and malformed operation chains', async () => {
    const wrongSource = blob('wrong', null, [])
    const forged = wrongSource.payload.replace('"sourceIdentityJson":"{\\"revision\\":1}"', '"sourceIdentityJson":"{\\"revision\\":2}"')
    await expect(materializeProjectionOutputManifest(wrongSource, identity, { readVerified: async () => forged }))
      .rejects.toThrow('PROJECTION_OUTPUT_MANIFEST_IDENTITY_MISMATCH')
    const cyclic = blob('cycle', { locator: 'cycle', byteLength: 10, payloadDigest: 'a'.repeat(64) }, [])
    await expect(materializeProjectionOutputManifest(cyclic, identity, { readVerified: async () => cyclic.payload }))
      .rejects.toThrow('PROJECTION_OUTPUT_MANIFEST_CYCLE')
    const malformed = blob('bad-operation', null, [{ type: 'append', messages: [{ role: 'user' }] }])
    await expect(materializeProjectionOutputManifest(malformed, identity, { readVerified: async () => malformed.payload }))
      .rejects.toThrow('PROJECTION_OUTPUT_OPERATION_INVALID')
  })
})
