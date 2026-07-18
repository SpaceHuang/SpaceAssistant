import { describe, expect, it } from 'vitest'
import { extractExplicitPathEvidence } from './explicitPathEvidence'

describe('extractExplicitPathEvidence', () => {
  it('creates stable evidence IDs and source spans for quoted output paths', () => {
    const message = '请保存为 `reports/final.md`，然后写入 "src/auth.ts"。'

    const evidence = extractExplicitPathEvidence(message, { requestId: 'request-1' })

    expect(evidence).toMatchObject([
      {
        evidenceId: 'request-1:5:23',
        rawPath: 'reports/final.md',
        start: 5,
        end: 23,
        intent: 'output'
      },
      {
        evidenceId: 'request-1:29:42',
        rawPath: 'src/auth.ts',
        start: 29,
        end: 42,
        intent: 'output'
      }
    ])
  })
})
