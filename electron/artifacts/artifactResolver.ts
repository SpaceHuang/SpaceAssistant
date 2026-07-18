import path from 'node:path'
import type { ArtifactPathProvenance, ArtifactWriteIntent } from '../../src/shared/artifactTypes'

export interface ResolvedArtifactOutput {
  finalPath: string
  canonicalPath: string
  provenance: ArtifactPathProvenance
}

/** Resolves artifact destinations; project paths are never redirected or renamed. */
export function resolveArtifactOutput(input: {
  workDir: string
  intent: ArtifactWriteIntent
  existingArtifact?: { artifactId: string; canonicalPath: string }
}): ResolvedArtifactOutput {
  if (input.intent.container !== 'project') throw new Error('Artifact resolver branch not implemented for this container')
  if (!input.intent.requestedPath) throw new Error('Project artifact requires requestedPath')
  const { pathSource, pathEvidenceId } = input.intent
  const provenance = pathSource === 'user'
    ? { pathSource, pathEvidenceId: pathEvidenceId! }
    : { pathSource }
  if (input.intent.artifactId && input.existingArtifact?.artifactId === input.intent.artifactId) {
    return {
      finalPath: path.relative(input.workDir, input.existingArtifact.canonicalPath),
      canonicalPath: input.existingArtifact.canonicalPath,
      provenance
    }
  }
  return { finalPath: input.intent.requestedPath, canonicalPath: path.resolve(input.workDir, input.intent.requestedPath), provenance }
}
