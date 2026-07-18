import type { ArtifactWriteIntent } from '../../src/shared/artifactTypes'
import { resolveArtifactOutput, type ResolvedArtifactOutput } from './artifactResolver'

export function resolveToolArtifactPath(input: {
  workDir: string
  sessionId: string
  toolUseId: string
  path: string
  artifact: unknown
}): ResolvedArtifactOutput {
  if (!input.artifact || typeof input.artifact !== 'object') throw new Error('Missing artifact write intent')
  const intent = input.artifact as ArtifactWriteIntent
  if (!intent.container || !intent.role || !intent.pathSource) throw new Error('Invalid artifact write intent')
  return resolveArtifactOutput({
    workDir: input.workDir,
    sessionId: input.sessionId,
    toolUseId: input.toolUseId,
    intent: { ...intent, requestedPath: intent.requestedPath ?? input.path }
  })
}
