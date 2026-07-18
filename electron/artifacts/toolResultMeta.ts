import type { ArtifactContainer, ArtifactPathProvenance, ArtifactRole } from '../../src/shared/artifactTypes'

export interface ArtifactToolResultMeta {
  artifactId: string
  container: ArtifactContainer
  role: ArtifactRole
  pathKind: 'file' | 'directory'
  requestedPath?: string
  finalPath: string
  provenance: ArtifactPathProvenance
  reason?: string
}

export function buildArtifactPathResolvedResult(input: ArtifactToolResultMeta): {
  type: 'tool:path-resolved'
  path: string
  metadata: ArtifactToolResultMeta
} {
  return { type: 'tool:path-resolved', path: input.finalPath, metadata: input }
}
