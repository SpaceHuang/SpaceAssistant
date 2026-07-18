import type { ArtifactToolResultMeta } from '../../src/shared/artifactTypes'

export type { ArtifactToolResultMeta }

export function buildArtifactPathResolvedResult(input: ArtifactToolResultMeta): {
  type: 'tool:path-resolved'
  path: string
  metadata: ArtifactToolResultMeta
} {
  return { type: 'tool:path-resolved', path: input.finalPath, metadata: input }
}
