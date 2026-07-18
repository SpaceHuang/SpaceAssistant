import { ErrorCodes } from '../../src/shared/errorCodes'
import type { ExplicitPathEvidence } from './explicitPathEvidence'

/** Verifies that a model's claimed user path is anchored in this request's output evidence. */
export function validateUserPathEvidence(input: {
  requestId: string
  requestedPath: string
  evidenceId: string
  evidence: ExplicitPathEvidence[]
}): ExplicitPathEvidence {
  const found = input.evidence.find((item) => item.evidenceId === input.evidenceId)
  if (!found || !found.evidenceId.startsWith(`${input.requestId}:`) || found.intent !== 'output') {
    throw new Error(`${ErrorCodes.ARTIFACT_EXPLICIT_PATH_UNRESOLVED}: invalid user path evidence`)
  }
  if (found.rawPath !== input.requestedPath) {
    throw new Error(`${ErrorCodes.ARTIFACT_EXPLICIT_PATH_UNRESOLVED}: evidence path does not match requested path`)
  }
  return found
}
