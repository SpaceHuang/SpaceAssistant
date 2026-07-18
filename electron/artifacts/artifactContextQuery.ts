import path from 'node:path'
import type { ArtifactContainer, ArtifactRole, PrimaryStage } from '../../src/shared/artifactTypes'
import type { ArtifactRepository } from './artifactRepository'

export type ArtifactContextSummary = {
  artifactId: string
  title: string
  container: ArtifactContainer
  role: ArtifactRole
  stage?: PrimaryStage
  canonicalPath: string
  packageId?: string
}

const MAX_CONTEXT_ARTIFACTS = 20

/** Builds recent active artifact summaries for cross-turn prompt injection. */
export function buildArtifactContextSummaries(
  repository: Pick<ArtifactRepository, 'listRecentActiveBySession'>,
  sessionId: string
): ArtifactContextSummary[] {
  return repository.listRecentActiveBySession(sessionId, MAX_CONTEXT_ARTIFACTS).map((artifact) => ({
    artifactId: artifact.id,
    title: artifact.title,
    container: artifact.container,
    role: artifact.role,
    ...(artifact.stage ? { stage: artifact.stage } : {}),
    canonicalPath: artifact.canonicalPath,
    ...(artifact.packageId ? { packageId: artifact.packageId } : {})
  }))
}

export function formatArtifactContextBlock(summaries: ArtifactContextSummary[], workDir: string): string {
  if (summaries.length === 0) return ''
  const lines = summaries.map((item, index) => {
    const rel = toDisplayPath(workDir, item.canonicalPath)
    const stage = item.stage ? ` stage=${item.stage}` : ''
    const pkg = item.packageId ? ` packageId=${item.packageId}` : ''
    return `${index + 1}. ${item.artifactId} · ${item.title} · ${item.container}/${item.role}${stage}${pkg} · ${rel}`
  })
  return ['Recent session artifacts (reuse artifactId when continuing edits):', ...lines].join('\n')
}

function toDisplayPath(workDir: string, canonicalPath: string): string {
  const relative = path.relative(workDir, canonicalPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return canonicalPath
  return relative.split(path.sep).join('/')
}
