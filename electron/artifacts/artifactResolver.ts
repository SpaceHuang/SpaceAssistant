import path from 'node:path'
import type { ArtifactPathProvenance, ArtifactWriteIntent } from '../../src/shared/artifactTypes'

export interface ResolvedArtifactOutput {
  finalPath: string
  canonicalPath: string
  provenance: ArtifactPathProvenance
  decision?: { kind: 'output-location'; packageId?: string } | { kind: 'ownership' } | { kind: 'overwrite' }
}

/** Resolves artifact destinations; project paths are never redirected or renamed. */
export function resolveArtifactOutput(input: {
  workDir: string
  intent: ArtifactWriteIntent
  existingArtifact?: { artifactId: string; canonicalPath: string }
  packagePrimaryPath?: string
  sessionId?: string
  toolUseId?: string
  occupiedPaths?: readonly string[]
}): ResolvedArtifactOutput {
  if (input.intent.container === 'scratch') {
    if (!input.sessionId) throw new Error('Scratch artifact requires sessionId')
    if (input.intent.artifactId && input.existingArtifact?.artifactId === input.intent.artifactId) {
      return {
        finalPath: path.relative(input.workDir, input.existingArtifact.canonicalPath),
        canonicalPath: input.existingArtifact.canonicalPath,
        provenance: { pathSource: 'system-assigned' }
      }
    }
    if (input.intent.artifactId) throw new Error('Artifact canonical path is unavailable for supplied artifactId')
    const kind = input.intent.materialKind ?? 'other'
    const directory = path.posix.join('.spaceassistant', 'runs', input.sessionId, kind)
    let filename = safeScratchFileName(input.intent.title)
    let finalPath = path.posix.join(directory, filename)
    if (input.occupiedPaths?.includes(finalPath)) {
      const parsed = path.posix.parse(filename)
      filename = `${parsed.name}-${(input.toolUseId ?? 'tool').slice(0, 9)}${parsed.ext}`
      finalPath = path.posix.join(directory, filename)
    }
    return { finalPath, canonicalPath: path.resolve(input.workDir, finalPath), provenance: { pathSource: 'system-assigned' } }
  }
  if (input.intent.container !== 'project' && input.intent.container !== 'package') throw new Error('Artifact resolver branch not implemented for this container')
  const { pathSource, pathEvidenceId } = input.intent
  const provenance = pathSource === 'user'
    ? { pathSource, pathEvidenceId: pathEvidenceId! }
    : { pathSource }
  if (!input.intent.requestedPath) {
    if (input.intent.container === 'package' && input.intent.role === 'primary') {
      return { finalPath: '', canonicalPath: '', provenance, decision: { kind: 'output-location', packageId: input.intent.packageId } }
    }
    if (input.intent.container === 'package' && (input.intent.role === 'supporting' || input.intent.role === 'reference') && !input.intent.packageId) {
      return { finalPath: '', canonicalPath: '', provenance, decision: { kind: 'ownership' } }
    }
    if (input.intent.container === 'package' && (input.intent.role === 'supporting' || input.intent.role === 'reference') && input.intent.packageId && input.packagePrimaryPath) {
      let finalPath = derivePackageMaterialPath(input.packagePrimaryPath, input.intent.title, input.intent.materialKind)
      if (input.occupiedPaths?.includes(finalPath)) {
        const parsed = path.posix.parse(finalPath)
        finalPath = path.posix.join(parsed.dir, input.intent.role === 'reference' ? 'references' : 'supporting', parsed.base)
      }
      return { finalPath, canonicalPath: path.resolve(input.workDir, finalPath), provenance }
    }
    throw new Error(`${input.intent.container} artifact requires requestedPath`)
  }
  if (input.intent.artifactId && input.existingArtifact?.artifactId !== input.intent.artifactId) {
    throw new Error('Artifact canonical path is unavailable for supplied artifactId')
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
  if (!input.intent.artifactId && input.occupiedPaths?.includes(finalPath)) {
    return { finalPath, canonicalPath: path.resolve(input.workDir, finalPath), provenance, decision: { kind: 'overwrite' } }
  }
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

function safeScratchFileName(title?: string): string {
  const candidate = path.posix.basename(title?.replace(/\\/g, '/') || 'artifact')
  return candidate.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'artifact'
}
