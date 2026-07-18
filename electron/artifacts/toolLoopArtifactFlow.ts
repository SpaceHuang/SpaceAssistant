import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ArtifactWriteIntent } from '../../src/shared/artifactTypes'
import type { AppDatabase } from '../database'
import { ArtifactRepository } from './artifactRepository'
import { resolveArtifactOutputAfterDecision, type OverwritePathDecisionResponse } from './artifactDecisionReresolve'
import { ArtifactChangeCursor } from './changeCursor'
import type { ResolvedArtifactOutput } from './artifactResolver'
import { resolveToolArtifactPath } from './toolArtifactPath'
import { registerAfterSuccessfulWrite } from './postWriteRegistration'
import { registerResolvedArtifactWrite } from './writeRegistration'
import type { ArtifactDecisionKind } from '../../src/shared/artifactDecisionTypes'
import {
  registerArtifactDecisionRequest,
  waitForArtifactDecisionResponse
} from './artifactDecisionBridge'
import { buildArtifactPathResolvedResult, type ArtifactToolResultMeta } from './toolResultMeta'

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
}

export function listArtifactOccupiedPaths(db: AppDatabase, sessionId: string, workDir: string): string[] {
  return new ArtifactRepository(db)
    .listBySession(sessionId)
    .filter((artifact) => artifact.status === 'active')
    .map((artifact) => path.relative(workDir, artifact.canonicalPath).replace(/\\/g, '/'))
}

export function createToolLoopArtifactState(requestId: string): ToolLoopArtifactState {
  return { changeCursor: new ArtifactChangeCursor(requestId) }
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

function decisionOptions(kind: NonNullable<ResolvedArtifactOutput['decision']>['kind']) {
  if (kind === 'overwrite') {
    return [
      { key: 'overwrite', label: 'Overwrite' },
      { key: 'rename', label: 'Rename', requiresInput: 'rename' as const },
      { key: 'change-directory', label: 'Change directory', requiresInput: 'directory' as const },
      { key: 'cancel', label: 'Cancel' }
    ]
  }
  return [{ key: 'cancel', label: 'Cancel' }]
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
}): PrepareArtifactWriteResult {
  try {
    const resolved = resolveToolArtifactPath({
      workDir: input.workDir,
      sessionId: input.sessionId,
      toolUseId: input.toolUseId,
      path: input.path,
      artifact: input.artifact,
      occupiedPaths: input.occupiedPaths
    })
    if (resolved.decision) {
      const groupKey = decisionGroupKey(resolved, input.path)
      const pending = registerArtifactDecisionRequest({
        requestId: input.requestId,
        sessionId: input.sessionId,
        toolUseId: input.toolUseId,
        attempt: input.attempt ?? 0,
        groupKey,
        kind: resolved.decision.kind as ArtifactDecisionKind,
        options: decisionOptions(resolved.decision.kind)
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

function parseOverwriteDecisionChoice(choice: string): OverwritePathDecisionResponse {
  const trimmed = choice.trim()
  if (trimmed === 'overwrite') return { action: 'overwrite' }
  if (trimmed === 'cancel') return { action: 'cancel' }
  if (trimmed.startsWith('rename:')) return { action: 'rename', newName: trimmed.slice('rename:'.length) }
  if (trimmed.startsWith('change-directory:')) {
    return { action: 'change-directory', newDirectory: trimmed.slice('change-directory:'.length) }
  }
  throw new Error(`Unsupported artifact decision choice: ${choice}`)
}

export async function resumeArtifactToolWriteAfterDecision(input: {
  workDir: string
  sessionId: string
  requestId: string
  toolUseId: string
  path: string
  artifact: unknown
  decisionId: string
  attempt: number
  choice: string
  previousFinalPath: string
  occupiedPaths?: readonly string[]
}): Promise<PrepareArtifactWriteResult> {
  try {
    const intent = input.artifact as ArtifactWriteIntent
    const response = parseOverwriteDecisionChoice(input.choice)
    const reresolved = await resolveArtifactOutputAfterDecision({
      workDir: input.workDir,
      attempt: input.attempt,
      decisionId: input.decisionId,
      previousFinalPath: input.previousFinalPath,
      intent,
      occupiedPaths: input.occupiedPaths,
      sessionId: input.sessionId,
      toolUseId: input.toolUseId,
      response
    })
    if (reresolved.decision) {
      const groupKey = decisionGroupKey(reresolved, input.path)
      const pending = registerArtifactDecisionRequest({
        requestId: input.requestId,
        sessionId: input.sessionId,
        toolUseId: input.toolUseId,
        attempt: reresolved.attempt,
        groupKey,
        kind: reresolved.decision.kind as ArtifactDecisionKind,
        options: decisionOptions(reresolved.decision.kind)
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
  onDecisionRequired?: (pending: Extract<PrepareArtifactWriteResult, { kind: 'decision_required' }>) => void
}): Promise<PrepareArtifactWriteResult> {
  let current = prepareArtifactToolWrite(input)
  while (current.kind === 'decision_required') {
    const waitPromise = waitForArtifactDecisionResponse(input.requestId, input.toolUseId)
    input.onDecisionRequired?.(current)
    const choice = await waitPromise
    if (!choice || choice === 'cancel') {
      return { kind: 'error', message: choice === 'cancel' ? 'Artifact decision cancelled' : 'Artifact decision timed out' }
    }
    current = await resumeArtifactToolWriteAfterDecision({
      workDir: input.workDir,
      sessionId: input.sessionId,
      requestId: input.requestId,
      toolUseId: input.toolUseId,
      path: input.path,
      artifact: input.artifact,
      decisionId: current.decisionId,
      attempt: current.attempt,
      choice,
      previousFinalPath: current.previousFinalPath,
      occupiedPaths: input.occupiedPaths
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
    registerAfterSuccessfulWrite({
      success: true,
      register: () => {
        const record = registerResolvedArtifactWrite({
          repository: new ArtifactRepository(input.db),
          sessionId: input.sessionId,
          workDirProfileId: input.workDirProfileId,
          workspaceRootReal: input.workDir,
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
