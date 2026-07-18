import { describe, expect, it } from 'vitest'
import { extractExplicitPathEvidence } from './explicitPathEvidence'
import { validateUserPathEvidence } from './evidenceValidation'

describe('validateUserPathEvidence', () => {
  it('rejects forged evidence IDs and mismatched declared paths', () => {
    const evidence = extractExplicitPathEvidence('保存为 `reports/final.md`', { requestId: 'request-1' })

    expect(() => validateUserPathEvidence({
      requestId: 'request-1',
      requestedPath: 'reports/final.md',
      evidenceId: 'forged',
      evidence
    })).toThrow(/evidence/i)
    expect(() => validateUserPathEvidence({
      requestId: 'request-1',
      requestedPath: 'reports/other.md',
      evidenceId: evidence[0]!.evidenceId,
      evidence
    })).toThrow(/path/i)
  })
})
