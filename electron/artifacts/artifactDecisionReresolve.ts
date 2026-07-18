import path from 'node:path'
import type { ArtifactWriteIntent } from '../../src/shared/artifactTypes'
import { resolveArtifactSafeTarget } from './safeTarget'
import { resolveArtifactOutput, type ResolvedArtifactOutput } from './artifactResolver'
import { validateDecisionDirectory, validateDecisionRename } from './pathDecisionInput'
import { artifactPathIdentity } from './pathIdentity'

export type OverwritePathDecisionResponse =
  | { action: 'rename'; newName: string }
  | { action: 'change-directory'; newDirectory: string }
  | { action: 'overwrite' }
  | { action: 'cancel' }

export type ArtifactDecisionReresolveResult = ResolvedArtifactOutput & {
  attempt: number
  pathIdentityKey: string
}

function buildNextPath(previousFinalPath: string, response: Extract<OverwritePathDecisionResponse, { action: 'rename' | 'change-directory' }>): string {
  const previous = previousFinalPath.replace(/\\/g, '/')
  const previousDir = path.posix.dirname(previous)
  const previousBase = path.posix.basename(previous)
  if (response.action === 'rename') {
    const name = validateDecisionRename(response.newName)
    return previousDir === '.' ? name : path.posix.join(previousDir, name)
  }
  return path.posix.join(validateDecisionDirectory(response.newDirectory), previousBase)
}

/**
 * Applies a trusted overwrite path decision, then fully re-runs resolve + safety checks.
 * Never reuses the previous finalPath evidence or overwrite approval.
 */
export async function resolveArtifactOutputAfterDecision(input: {
  workDir: string
  attempt: number
  decisionId: string
  previousFinalPath: string
  intent: ArtifactWriteIntent
  occupiedPaths?: readonly string[]
  existingArtifact?: { artifactId: string; canonicalPath: string }
  packagePrimaryPath?: string
  sessionId?: string
  toolUseId?: string
  expectedWorkspaceRootReal?: string
  response: OverwritePathDecisionResponse
}): Promise<ArtifactDecisionReresolveResult> {
  if (input.response.action === 'cancel') throw new Error('Artifact overwrite decision cancelled')

  const nextPath = input.response.action === 'overwrite'
    ? input.previousFinalPath.replace(/\\/g, '/')
    : buildNextPath(input.previousFinalPath, input.response)

  const safeTarget = await resolveArtifactSafeTarget(input.workDir, nextPath, input.expectedWorkspaceRootReal)
  const pathIdentityKey = artifactPathIdentity(safeTarget.targetPath)

  const resolved = resolveArtifactOutput({
    workDir: input.workDir,
    intent: {
      ...input.intent,
      requestedPath: nextPath
    },
    occupiedPaths: input.response.action === 'overwrite'
      ? (input.occupiedPaths ?? []).filter((p) => p !== nextPath)
      : input.occupiedPaths,
    existingArtifact: input.existingArtifact,
    packagePrimaryPath: input.packagePrimaryPath,
    sessionId: input.sessionId,
    toolUseId: input.toolUseId
  })

  return {
    ...resolved,
    provenance: { pathSource: 'user-decision', pathDecisionId: input.decisionId },
    attempt: input.attempt + 1,
    pathIdentityKey
  }
}
