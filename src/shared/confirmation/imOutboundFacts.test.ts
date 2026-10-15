import { describe, expect, it } from 'vitest'
import { createImOutboundFacts } from './imOutboundFacts'

describe('IM outbound facts producer', () => {
  it('reports ordinary content as complete facts without retaining body text or a verdict', async () => {
    const body = 'The quarterly report is ready for review.'
    const facts = await createImOutboundFacts(body)

    expect(facts).toMatchObject({
      factId: expect.stringMatching(/^fact-[0-9a-f]{24}$/),
      classifierVersion: expect.any(String),
      inspectionCoverage: 'complete',
      evidenceKinds: []
    })
    expect(facts).not.toHaveProperty('decision')
    expect(facts).not.toHaveProperty('answerer')
    expect(JSON.stringify(facts)).not.toContain(body)
  })

  it('reports secret-shaped evidence without copying the secret into the fact record', async () => {
    const body = 'Deploy token: sk-1234567890abcdefghijklmnop'
    const facts = await createImOutboundFacts(body)

    expect(facts).toMatchObject({
      inspectionCoverage: 'complete',
      evidenceKinds: ['credential-like-pattern']
    })
    expect(JSON.stringify(facts)).not.toContain('sk-1234567890abcdefghijklmnop')
  })

  it('represents oversized content as unavailable inspection, not as a sensitive verdict', async () => {
    const facts = await createImOutboundFacts('x'.repeat(20_001))

    expect(facts).toMatchObject({ inspectionCoverage: 'unavailable', evidenceKinds: [] })
    expect(facts).not.toHaveProperty('decision')
  })

  it('produces stable fact and content digests for identical input and changes them when content changes', async () => {
    const first = await createImOutboundFacts('Same message')
    const repeat = await createImOutboundFacts('Same message')
    const changed = await createImOutboundFacts('Changed message')

    expect(repeat).toEqual(first)
    expect(changed.factId).not.toBe(first.factId)
    expect(changed.contentDigest).not.toBe(first.contentDigest)
  })
})
