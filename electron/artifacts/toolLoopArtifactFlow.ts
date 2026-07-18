import { randomUUID } from 'node:crypto'
import type { ArtifactWriteIntent } from '../../src/shared/artifactTypes'
import type { ArtifactPathProvenance } from '../../src/shared/artifactTypes'
import type { AppDatabase } from '../database'
import { ArtifactRepository } from './artifactRepository'
import { resolveArtifactOutputAfterDecision, type OverwritePathDecisionResponse } from './artifactDecisionReresolve'
import { ArtifactChangeCursor } from './changeCursor'
import type { ResolvedArtifactOutput } from './artifactResolver'
import { resolveToolArtifactPath, resolveWorkspaceRootReal } from './toolArtifactPath'
import { registerAfterSuccessfulWrite } from './postWriteRegistration'
import { registerResolvedArtifactWrite } from './writeRegistration'
import type { ArtifactDecisionKind } from '../../src/shared/artifactDecisionTypes'
import {
  registerArtifactDecisionRequest,
  waitForArtifactDecisionResponse
} from './artifactDecisionBridge'
import { buildArtifactPathResolvedResult, type ArtifactToolResultMeta } from './toolResultMeta'
import { buildArtifactDecisionOptions } from '../remote/artifactDecisionRemote'
import { ArtifactEvidenceConsumption } from './evidenceConsumption'
import { extractExplicitPathEvidence } from './explicitPathEvidence'
import { toArtifactRelativePath } from './artifactPathKeys'
import { writeScratchGitPolicyPreference } from './scratchGitPolicyStore'

export type PreparedArtifactWrite = {
  intent: ArtifactWriteIntent
  resolved: ResolvedArtifactOutput
  finalPath: string
  pathResolvedPayload: ReturnType<typeof buildArtifactPathResolvedResult>
}

export type PrepareArtifactWriteResult =
  | { kind: 'ready'; prepared: PreparedArtifactWrite }
  | { kind: 'decision_required'; decisionId: string; decisionKind: string; attempt: number; groupKey: string; previousFinalPath: string }
  | { kind: 'error'; message: string }

export type ToolLoopArtifactState = {
  changeCursor: ArtifactChangeCursor
  evidenceConsumption?: ArtifactEvidenceConsumption
}

export function listArtifactOccupiedPaths(db: AppDatabase, sessionId: string, workDir: string): string[] {
  return new ArtifactRepository(db)
    .listBySession(sessionId)
    .filter((artifact) => artifact.status === 'active')
    .map((artifact) => toArtifactRelativePath(workDir, artifact.canonicalPath))
}

export function createToolLoopArtifactState(requestId: string, userMessage = ''): ToolLoopArtifactState {
  return {
    changeCursor: new ArtifactChangeCursor(requestId),
    evidenceConsumption: new ArtifactEvidenceConsumption(extractExplicitPathEvidence(userMessage, { requestId }))
  }
}

function decisionGroupKey(resolved: ResolvedArtifactOutput, requestedPath: string): string {
  return `${resolved.decision?.kind ?? 'unknown'}:${resolved.finalPath || requestedPath}`
}

function inferPathKind(intent: ArtifactWriteIntent): 'file' | 'directory' {
  if (intent.pathKind === 'directory') return 'directory'
  if (intent.pathKind === 'file') return 'file'
  return 'file'
}

function buildPreparedWrite(input: {
  intent: ArtifactWriteIntent
  resolved: ResolvedArtifactOutput
  requestedPath: string
}): PreparedArtifactWrite {
  const finalPath = input.resolved.finalPath
  const metadata: ArtifactToolResultMeta = {
    artifactId: input.intent.artifactId ?? randomUUID(),
    container: input.intent.container,
    role: input.intent.role,
    pathKind: inferPathKind(input.intent),
    requestedPath: input.intent.requestedPath ?? input.requestedPath,
    finalPath,
    provenance: input.resolved.provenance,
    reason: input.intent.title
  }
  const intent = input.intent.artifactId ? input.intent : { ...input.intent, artifactId: metadata.artifactId }
  return {
    intent,
    resolved: input.resolved,
    finalPath,
    pathResolvedPayload: buildArtifactPathResolvedResult(metadata)
  }
}

export function prepareArtifactToolWrite(input: {
  workDir: string
  sessionId: string
  requestId: string
  toolUseId: string
  path: string
  artifact: unknown
  attempt?: number
  occupiedPaths?: readonly string[]
  db?: AppDatabase
  userMessage?: string
  evidenceConsumption?: ArtifactEvidenceConsumption
}): PrepareArtifactWriteResult {
  try {
    const resolved = resolveToolArtifactPath({
      workDir: input.workDir,
      sessionId: input.sessionId,
      toolUseId: input.toolUseId,
      path: input.path,
      artifact: input.artifact,
      occupiedPaths: input.occupiedPaths,
      db: input.db,
      requestId: input.requestId,
      userMessage: input.userMessage,
      evidenceConsumption: input.evidenceConsumption
    })
    if (resolved.decision) {
      const kind = resolved.decision.kind as ArtifactDecisionKind
      const groupKey = decisionGroupKey(resolved, input.path)
      const pending = registerArtifactDecisionRequest({
        requestId: input.requestId,
        sessionId: input.sessionId,
        toolUseId: input.toolUseId,
        attempt: input.attempt ?? 0,
        groupKey,
        kind,
        options: buildArtifactDecisionOptions(kind)
      })
      return {
        kind: 'decision_required',
        decisionId: pending.decisionId,
        decisionKind: resolved.decision.kind,
        attempt: pending.attempt,
        groupKey,
        previousFinalPath: resolved.finalPath || input.path
      }
    }
    const intent = input.artifact as ArtifactWriteIntent
    return {
      kind: 'ready',
      prepared: buildPreparedWrite({ intent, resolved, requestedPath: input.path })
    }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : 'Artifact path resolution failed' }
  }
}

function parseOverwriteDecisionChoice(choice: string): OverwritePathDecisionResponse | null {
  const trimmed = choice.trim()
  if (trimmed === 'overwrite') return { action: 'overwrite' }
  if (trimmed === 'cancel') return { action: 'cancel' }
  if (trimmed.startsWith('rename:')) return { action: 'rename', newName: trimmed.slice('rename:'.length) }
  if (trimmed.startsWith('change-directory:')) {
    return { action: 'change-directory', newDirectory: trimmed.slice('change-directory:'.length) }
  }
  return null
}

function applyNonOverwriteChoice(input: {
  intent: ArtifactWriteIntent
  decisionKind: string
  choice: string
  previousFinalPath: string
}): ArtifactWriteIntent {
  const trimmed = input.choice.trim()
  if (input.decisionKind === 'path-type' && (trimmed === 'file' || trimmed === 'directory')) {
    return { ...input.intent, pathKind: trimmed }
  }
  if (input.decisionKind === 'ownership') {
    if (trimmed === 'project') return { ...input.intent, container: 'project', role: 'primary' }
    if (trimmed === 'package') return { ...input.intent, container: 'package', role: input.intent.role === 'scratch' ? 'primary' : input.intent.role }
    if (trimmed === 'scratch') return { ...input.intent, container: 'scratch', role: 'scratch' }
  }
  if (input.decisionKind === 'output-location') {
    const directory = trimmed.startsWith('change-directory:')
      ? trimmed.slice('change-directory:'.length)
      : trimmed === 'custom'
        ? undefined
        : trimmed
    if (directory) {
      return {
        ...input.intent,
        requestedPath: directory.endsWith('/') ? directory : `${directory}/`,
        pathKind: 'directory'
      }
    }
  }
  return input.intent
}

export async function resumeArtifactToolWriteAfterDecision(input: {
  workDir: string
  sessionId: string
  requestId: string
  toolUseId: string
  path: string
  artifact: unknown
  decisionId: string
  decisionKind?: string
  attempt: number
  choice: string
  previousFinalPath: string
  occupiedPaths?: readonly string[]
  db?: AppDatabase
  userMessage?: string
  evidenceConsumption?: ArtifactEvidenceConsumption
  provenance?: Extract<ArtifactPathProvenance, { pathSource: 'user-decision' }>
}): Promise<PrepareArtifactWriteResult> {
  try {
    if (input.choice.trim() === 'cancel') {
      return { kind: 'error', message: 'Artifact decision cancelled' }
    }
    const decisionKind = input.decisionKind ?? 'overwrite'
    if (decisionKind === 'git-ignore') {
      if (input.choice === 'add-ignore' || input.choice === 'keep-visible') {
        if (input.db) {
          const session = new ArtifactRepository(input.db).listBySession(input.sessionId)[0]
          const profileId = session?.workDirProfileId
          if (profileId) writeScratchGitPolicyPreference(input.db, profileId, input.choice)
        }
        return prepareArtifactToolWrite({ ...input, attempt: input.attempt + 1 })
      }
      return { kind: 'error', message: 'Artifact decision cancelled' }
    }
    if (decisionKind === 'reference-retention') {
      if (input.choice === 'cancel') return { kind: 'error', message: 'Artifact decision cancelled' }
      // Retention choice is recorded via provenance/decision; continue with original intent.
      return prepareArtifactToolWrite({ ...input, attempt: input.attempt + 1 })
    }

    const overwrite = decisionKind === 'overwrite' ? parseOverwriteDecisionChoice(input.choice) : null
    if (overwrite) {
      const intent = input.artifact as ArtifactWriteIntent
      const reresolved = await resolveArtifactOutputAfterDecision({
        workDir: input.workDir,
        attempt: input.attempt,
        decisionId: input.decisionId,
        previousFinalPath: input.previousFinalPath,
        intent,
        occupiedPaths: input.occupiedPaths,
        sessionId: input.sessionId,
        toolUseId: input.toolUseId,
        response: overwrite
      })
      if (input.provenance) {
        reresolved.provenance = input.provenance
      }
      if (reresolved.decision) {
        const kind = reresolved.decision.kind as ArtifactDecisionKind
        const groupKey = decisionGroupKey(reresolved, input.path)
        const pending = registerArtifactDecisionRequest({
          requestId: input.requestId,
          sessionId: input.sessionId,
          toolUseId: input.toolUseId,
          attempt: reresolved.attempt,
          groupKey,
          kind,
          options: buildArtifactDecisionOptions(kind)
        })
        return {
          kind: 'decision_required',
          decisionId: pending.decisionId,
          decisionKind: reresolved.decision.kind,
          attempt: pending.attempt,
          groupKey,
          previousFinalPath: reresolved.finalPath || input.previousFinalPath
        }
      }
      return {
        kind: 'ready',
        prepared: buildPreparedWrite({ intent, resolved: reresolved, requestedPath: input.path })
      }
    }

    const nextIntent = applyNonOverwriteChoice({
      intent: input.artifact as ArtifactWriteIntent,
      decisionKind,
      choice: input.choice,
      previousFinalPath: input.previousFinalPath
    })
    return prepareArtifactToolWrite({
      ...input,
      artifact: nextIntent,
      attempt: input.attempt + 1
    })
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : 'Artifact decision resume failed' }
  }
}

export async function resolveArtifactToolWriteWithDecision(input: {
  workDir: string
  sessionId: string
  requestId: string
  toolUseId: string
  path: string
  artifact: unknown
  occupiedPaths?: readonly string[]
  db?: AppDatabase
  userMessage?: string
  evidenceConsumption?: ArtifactEvidenceConsumption
  signal?: AbortSignal
  onDecisionRequired?: (pending: Extract<PrepareArtifactWriteResult, { kind: 'decision_required' }>) => void
}): Promise<PrepareArtifactWriteResult> {
  let current = prepareArtifactToolWrite(input)
  while (current.kind === 'decision_required') {
    const waitPromise = waitForArtifactDecisionResponse(input.requestId, input.toolUseId, input.signal)
    input.onDecisionRequired?.(current)
    const response = await waitPromise
    if (!response || response.choice === 'cancel') {
      return { kind: 'error', message: response?.choice === 'cancel' ? 'Artifact decision cancelled' : 'Artifact decision timed out' }
    }
    current = await resumeArtifactToolWriteAfterDecision({
      workDir: input.workDir,
      sessionId: input.sessionId,
      requestId: input.requestId,
      toolUseId: input.toolUseId,
      path: input.path,
      artifact: input.artifact,
      decisionId: current.decisionId,
      decisionKind: current.decisionKind,
      attempt: current.attempt,
      choice: response.choice,
      previousFinalPath: current.previousFinalPath,
      occupiedPaths: input.occupiedPaths,
      db: input.db,
      userMessage: input.userMessage,
      evidenceConsumption: input.evidenceConsumption,
      provenance: response.provenance
    })
  }
  return current
}

export type RegisterArtifactWriteInput = {
  db: AppDatabase
  sessionId: string
  workDir: string
  workDirProfileId: string
  requestId: string
  prepared: PreparedArtifactWrite
  writeSucceeded: boolean
  changeCursor: ArtifactChangeCursor
  audit?: (event: string, detail: Record<string, unknown>) => void
}

export function registerArtifactWriteOutcome(input: RegisterArtifactWriteInput): { ok: true; artifactId: string } | { ok: false; error: string } {
  if (!input.writeSucceeded) return { ok: false, error: 'write_not_executed' }
  try {
    let artifactId = input.prepared.intent.artifactId ?? ''
    const workspaceRootReal = resolveWorkspaceRootReal(input.workDir)
    registerAfterSuccessfulWrite({
      success: true,
      register: () => {
        const record = registerResolvedArtifactWrite({
          repository: new ArtifactRepository(input.db),
          sessionId: input.sessionId,
          workDirProfileId: input.workDirProfileId,
          workDir: input.workDir,
          workspaceRootReal,
          intent: input.prepared.intent,
          resolved: input.prepared.resolved
        })
        artifactId = record.id
      }
    })
    input.changeCursor.record({
      requestId: input.requestId,
      artifactId,
      container: input.prepared.intent.container,
      role: input.prepared.intent.role,
      finalPath: input.prepared.finalPath,
      ...(input.prepared.intent.stage ? { stage: input.prepared.intent.stage } : {}),
      success: true
    })
    return { ok: true, artifactId }
  } catch (error) {
    const message = error instanceof Error ? error.message : '文件已写入但登记失败'
    input.audit?.('artifact.register.failed', {
      requestId: input.requestId,
      sessionId: input.sessionId,
      finalPath: input.prepared.finalPath,
      error: message
    })
    return { ok: false, error: message }
  }
}

/** @internal exported for integration tests */
export function artifactManagedWriteStageOrder(): readonly ['resolve', 'confirm', 'remote_grant', 'execute', 'register'] {
  return ['resolve', 'confirm', 'remote_grant', 'execute', 'register'] as const
}

/** @internal exported for integration tests */
export function runArtifactManagedWriteStagesForTests(input: {
  trace: string[]
  resolve: () => { finalPath: string }
  buildConfirmInput: (path: string) => Record<string, unknown>
  evaluateRemoteGrant?: () => void
  execute?: () => boolean
  register?: (success: boolean) => void
}): { confirmInput: Record<string, unknown>; registered: boolean } {
  input.trace.push('resolve')
  const { finalPath } = input.resolve()
  input.trace.push('confirm')
  const confirmInput = input.buildConfirmInput(finalPath)
  input.evaluateRemoteGrant?.()
  if (input.evaluateRemoteGrant) input.trace.push('remote_grant')
  const success = input.execute?.() ?? true
  input.trace.push('execute')
  input.register?.(success)
  if (input.register) input.trace.push('register')
  return { confirmInput, registered: success }
}
