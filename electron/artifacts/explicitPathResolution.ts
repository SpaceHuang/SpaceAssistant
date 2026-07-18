import type { ArtifactContainer } from '../../src/shared/artifactTypes'
import { ErrorCodes } from '../../src/shared/errorCodes'
import { ArtifactEvidenceConsumption } from './evidenceConsumption'

/** Prevents a new non-project artifact from silently bypassing an explicit user output path. */
export function assertNoUnresolvedExplicitOutputEvidence(input: {
  container: ArtifactContainer
  isNewArtifact: boolean
  consumption: ArtifactEvidenceConsumption
}): void {
  if (!input.isNewArtifact || input.container === 'project') return
  if (input.consumption.unconsumedOutputEvidence().length > 0) {
    throw new Error(`${ErrorCodes.ARTIFACT_EXPLICIT_PATH_UNRESOLVED}: explicit output path remains unresolved`)
  }
}
