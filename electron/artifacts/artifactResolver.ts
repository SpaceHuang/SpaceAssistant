import path from 'node:path'
import type { ArtifactPathProvenance, ArtifactWriteIntent } from '../../src/shared/artifactTypes'

export interface ResolvedArtifactOutput {
  finalPath: string
  canonicalPath: string
  provenance: ArtifactPathProvenance
  decision?: { kind: 'output-location'; packageId?: string }
}

/** Resolves artifact destinations; project paths are never redirected or renamed. */
export function resolveArtifactOutput(input: {
  workDir: string
  intent: ArtifactWriteIntent
  existingArtifact?: { artifactId: string; canonicalPath: string }
  packagePrimaryPath?: string
}): ResolvedArtifactOutput {
  if (input.intent.container !== 'project' && input.intent.container !== 'package') throw new Error('Artifact resolver branch not implemented for this container')
  const { pathSource, pathEvidenceId } = input.intent
  const provenance = pathSource === 'user'
    ? { pathSource, pathEvidenceId: pathEvidenceId! }
    : { pathSource }
  if (!input.intent.requestedPath) {
    if (input.intent.container === 'package' && input.intent.role === 'primary') {
      return { finalPath: '', canonicalPath: '', provenance, decision: { kind: 'output-location', packageId: input.intent.packageId } }
    }
    if (input.intent.container === 'package' && (input.intent.role === 'supporting' || input.intent.role === 'reference') && input.intent.packageId && input.packagePrimaryPath) {
      const finalPath = derivePackageMaterialPath(input.packagePrimaryPath, input.intent.title, input.intent.materialKind)
      return { finalPath, canonicalPath: path.resolve(input.workDir, finalPath), provenance }
    }
    throw new Error(`${input.intent.container} artifact requires requestedPath`)
  }
  if (input.intent.artifactId && input.existingArtifact?.artifactId === input.intent.artifactId) {
    return {
      finalPath: path.relative(input.workDir, input.existingArtifact.canonicalPath),
      canonicalPath: input.existingArtifact.canonicalPath,
      provenance
    }
  }
  const finalPath = input.intent.container === 'package' && input.intent.role === 'primary' && input.intent.pathKind === 'directory'
    ? path.join(input.intent.requestedPath, primaryFileName(input.intent.title))
    : input.intent.requestedPath
  return { finalPath, canonicalPath: path.resolve(input.workDir, finalPath), provenance }
}

function primaryFileName(title?: string): string {
  const slug = title?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${slug || 'artifact'}.md`
}

function derivePackageMaterialPath(primaryPath: string, title: string | undefined, materialKind: ArtifactWriteIntent['materialKind']): string {
  const parsed = path.posix.parse(primaryPath.replace(/\\/g, '/'))
  const base = `${parsed.name}.materials`
  const slug = title?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'artifact'
  const extension = materialKind === 'script' ? '.ts' : materialKind === 'query' ? '.sql' : materialKind === 'data' ? '.json' : '.md'
  return path.posix.join(parsed.dir, base, `${slug}${extension}`)
}
