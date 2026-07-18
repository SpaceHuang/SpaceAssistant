import { describe, expect, it } from 'vitest'
import { extractExplicitPathEvidence } from './explicitPathEvidence'
import { ArtifactEvidenceConsumption } from './evidenceConsumption'

describe('ArtifactEvidenceConsumption', () => {
  it('keeps multiple output paths independent and consumes them one at a time', () => {
    const evidence = extractExplicitPathEvidence('保存为 `reports/a.md` 和 `reports/b.md`', { requestId: 'request-1' })
    const consumption = new ArtifactEvidenceConsumption(evidence)

    consumption.consume(evidence[0]!.evidenceId)

    expect(consumption.unconsumedOutputEvidence().map((item) => item.rawPath)).toEqual(['reports/b.md'])
  })
})
