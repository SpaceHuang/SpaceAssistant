import { describe, expect, it } from 'vitest'
import { createImAttachmentFacts } from './imAttachmentFacts'

describe('IM attachment facts producer', () => {
  const digest = 'a'.repeat(64)

  it('returns a content-free complete fact for a safe attachment', async () => {
    const facts = await createImAttachmentFacts({ fileName: 'report.txt', relativePath: 'reports/report.txt',
      content: 'The project report is ready.', contentDigest: digest, inspectionCoverage: 'complete' })

    expect(facts).toMatchObject({
      factId: expect.stringMatching(/^fact-[0-9a-f]{24}$/), contentDigest: digest,
      inspectionCoverage: 'complete', evidenceKinds: []
    })
    expect(JSON.stringify(facts)).not.toContain('The project report is ready.')
    expect(JSON.stringify(facts)).not.toContain('reports/report.txt')
    expect(facts).not.toHaveProperty('attachmentAuthorized')
    expect(facts).not.toHaveProperty('decision')
  })

  it('reports credential and personal-data evidence as distinct observations', async () => {
    const facts = await createImAttachmentFacts({ fileName: 'notes.txt', relativePath: 'notes.txt',
      content: 'api_key=sk-1234567890abcdefghijklmnop contact person@example.com', contentDigest: digest,
      inspectionCoverage: 'complete' })

    expect(facts.evidenceKinds).toEqual(['credential-like-pattern', 'personal-data-pattern'])
    expect(JSON.stringify(facts)).not.toContain('person@example.com')
    expect(JSON.stringify(facts)).not.toContain('sk-1234567890abcdefghijklmnop')
  })

  it('reports sensitive path metadata without returning the path itself', async () => {
    const facts = await createImAttachmentFacts({ fileName: 'credentials.json', relativePath: 'private/credentials.json',
      content: 'ordinary text', contentDigest: digest, inspectionCoverage: 'complete' })

    expect(facts.evidenceKinds).toContain('sensitive-path-name')
    expect(JSON.stringify(facts)).not.toContain('private/credentials.json')
  })

  it('preserves partial or unavailable inspection as coverage facts without inventing a risk label', async () => {
    const partial = await createImAttachmentFacts({ fileName: 'notes.txt', relativePath: 'notes.txt', content: '',
      contentDigest: digest, inspectionCoverage: 'partial' })
    const unavailable = await createImAttachmentFacts({ fileName: 'archive.bin', relativePath: 'archive.bin', content: '',
      contentDigest: digest, inspectionCoverage: 'unavailable' })

    expect(partial).toMatchObject({ inspectionCoverage: 'partial', evidenceKinds: [] })
    expect(unavailable).toMatchObject({ inspectionCoverage: 'unavailable', evidenceKinds: [] })
  })
})
