import { describe, expect, it } from 'vitest'
import { extractExplicitPathEvidence } from './explicitPathEvidence'
import { ArtifactEvidenceConsumption } from './evidenceConsumption'
import { assertNoUnresolvedExplicitOutputEvidence } from './explicitPathResolution'

describe('ArtifactEvidenceConsumption', () => {
  it('keeps multiple output paths independent and consumes them one at a time', () => {
    const evidence = extractExplicitPathEvidence('保存为 `reports/a.md` 和 `reports/b.md`', { requestId: 'request-1' })
    const consumption = new ArtifactEvidenceConsumption(evidence)

    consumption.consume(evidence[0]!.evidenceId)

    expect(consumption.unconsumedOutputEvidence().map((item) => item.rawPath)).toEqual(['reports/b.md'])
  })

  it.each(['package', 'scratch'] as const)('rejects a new %s write while explicit output evidence remains unresolved', (container) => {
    const evidence = extractExplicitPathEvidence('保存为 `reports/final.md`', { requestId: 'request-2' })
    const consumption = new ArtifactEvidenceConsumption(evidence)

    expect(() => assertNoUnresolvedExplicitOutputEvidence({ container, isNewArtifact: true, consumption })).toThrow(
      'ARTIFACT_EXPLICIT_PATH_UNRESOLVED'
    )
  })
})
