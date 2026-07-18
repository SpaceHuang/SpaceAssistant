import fs from 'node:fs'
import path from 'node:path'
import type { ArtifactWriteIntent } from '../../src/shared/artifactTypes'
import type { AppDatabase } from '../database'
import { resolveArtifactOutput, type ResolvedArtifactOutput } from './artifactResolver'
import { ArtifactRepository } from './artifactRepository'
import { extractExplicitPathEvidence } from './explicitPathEvidence'
import { ArtifactEvidenceConsumption } from './evidenceConsumption'
import { validateUserPathEvidence } from './evidenceValidation'
import { assertNoUnresolvedExplicitOutputEvidence } from './explicitPathResolution'

export type ResolveToolArtifactPathInput = {
  workDir: string
  sessionId: string
  toolUseId: string
  path: string
  artifact: unknown
  occupiedPaths?: readonly string[]
  /** Required for production wiring of existingArtifact / packagePrimary / evidence. */
  db?: AppDatabase
  requestId?: string
  userMessage?: string
  evidenceConsumption?: ArtifactEvidenceConsumption
}

function toAbsoluteCanonical(workDir: string, canonicalPath: string): string {
  return path.isAbsolute(canonicalPath) ? canonicalPath : path.resolve(workDir, canonicalPath)
}

function loadExistingArtifact(
  db: AppDatabase | undefined,
  workDir: string,
  artifactId: string | undefined
): { artifactId: string; canonicalPath: string } | undefined {
  if (!db || !artifactId) return undefined
  const record = new ArtifactRepository(db).find(artifactId)
  if (!record || record.status !== 'active') return undefined
  return { artifactId: record.id, canonicalPath: toAbsoluteCanonical(workDir, record.canonicalPath) }
}

function loadPackagePrimaryPath(
  db: AppDatabase | undefined,
  sessionId: string,
  workDir: string,
  packageId: string | undefined
): string | undefined {
  if (!db || !packageId) return undefined
  const primary = new ArtifactRepository(db)
    .listBySession(sessionId)
    .find((item) => item.id === packageId && item.container === 'package' && item.role === 'primary' && item.status === 'active')
  if (!primary) return undefined
  const relative = path.isAbsolute(primary.canonicalPath)
    ? path.relative(workDir, primary.canonicalPath)
    : primary.canonicalPath
  return relative.replace(/\\/g, '/')
}

function ensureEvidenceConsumption(input: ResolveToolArtifactPathInput): ArtifactEvidenceConsumption | undefined {
  if (input.evidenceConsumption) return input.evidenceConsumption
  if (!input.requestId || input.userMessage === undefined) return undefined
  return new ArtifactEvidenceConsumption(extractExplicitPathEvidence(input.userMessage, { requestId: input.requestId }))
}

/** Resolves a tool write intent with repository context and user-path evidence checks. */
export function resolveToolArtifactPath(input: ResolveToolArtifactPathInput): ResolvedArtifactOutput {
  if (!input.artifact || typeof input.artifact !== 'object') throw new Error('Missing artifact write intent')
  const intent = input.artifact as ArtifactWriteIntent
  if (!intent.container || !intent.role || !intent.pathSource) throw new Error('Invalid artifact write intent')

  const existingArtifact = loadExistingArtifact(input.db, input.workDir, intent.artifactId)
  if (intent.artifactId && !existingArtifact) {
    throw new Error('Artifact canonical path is unavailable for supplied artifactId')
  }

  const packagePrimaryPath = loadPackagePrimaryPath(input.db, input.sessionId, input.workDir, intent.packageId)
  const consumption = ensureEvidenceConsumption(input)
  const shouldDerivePackagePath =
    intent.container === 'package' &&
    (intent.role === 'supporting' || intent.role === 'reference') &&
    Boolean(intent.packageId) &&
    !intent.requestedPath
  const shouldAskOutputLocation =
    intent.container === 'package' && intent.role === 'primary' && !intent.requestedPath
  const requestedPath = intent.requestedPath ?? (shouldDerivePackagePath || shouldAskOutputLocation ? undefined : input.path)

    if (intent.pathSource === 'user') {
    if (!input.requestId || !consumption) {
      throw new Error('ARTIFACT_EXPLICIT_PATH_UNRESOLVED: user path evidence requires request context')
    }
    if (!intent.pathEvidenceId || !requestedPath) {
      throw new Error('ARTIFACT_EXPLICIT_PATH_UNRESOLVED: user path evidence id is required')
    }
    validateUserPathEvidence({
      requestId: input.requestId,
      requestedPath,
      evidenceId: intent.pathEvidenceId,
      evidence: [...consumption.all()]
    })
  }

  const isNewArtifact = !intent.artifactId
  // Claiming a validated user path consumes that evidence; other new package/scratch writes must not bypass leftovers.
  if (consumption && !(intent.pathSource === 'user' && intent.pathEvidenceId)) {
    assertNoUnresolvedExplicitOutputEvidence({
      container: intent.container,
      isNewArtifact,
      consumption
    })
  }

  const resolved = resolveArtifactOutput({
    workDir: input.workDir,
    sessionId: input.sessionId,
    toolUseId: input.toolUseId,
    occupiedPaths: input.occupiedPaths,
    existingArtifact,
    packagePrimaryPath,
    intent: requestedPath === undefined ? intent : { ...intent, requestedPath }
  })

  if (intent.pathSource === 'user' && intent.pathEvidenceId && consumption && !resolved.decision) {
    consumption.consume(intent.pathEvidenceId)
  }

  return resolved
}

/** Resolves the real workspace root for registration and lease keys. */
export function resolveWorkspaceRootReal(workDir: string): string {
  try {
    return fs.realpathSync(workDir)
  } catch {
    return path.resolve(workDir)
  }
}
