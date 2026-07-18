import path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { ArtifactDecisionResponsePayload, ArtifactApiItem } from '../../src/shared/api'
import type { WorkDirProfile } from '../../src/shared/feishuTypes'
import { ErrorCodes } from '../../src/shared/errorCodes'
import type { AppDatabase } from '../database'
import { getSession, updateSession } from '../database'
import { ArtifactRepository } from './artifactRepository'
import { cleanArtifactSession } from './artifactCleanSession'
import { deleteArtifactFile } from './artifactDeletion'
import { submitArtifactDecisionResponse } from './artifactDecisionBridge'
import { resolveArtifactMutationWorkspace } from './artifactMutationGuard'
import { validateDecisionDirectory, validateDecisionRename } from './pathDecisionInput'
import { getSharedArtifactPathLeaseRegistry, artifactDeleteLeaseIdentity } from './toolPathLease'
import { buildArtifactContextSummaries, type ArtifactContextSummary } from './artifactContextQuery'
import { relocateArtifact } from './relocateRecovery'

export type ArtifactIpcDeps = {
  db: AppDatabase
  getProfiles: () => WorkDirProfile[]
  getActiveProfileId: () => string
  notifyChanged: (event: { sessionId: string; artifactId: string; action: 'created' | 'updated' | 'deleted' }) => void
}

function toApiItem(
  artifact: ReturnType<ArtifactRepository['listBySession']>[number],
  workDir: string
): ArtifactApiItem {
  return {
    id: artifact.id,
    sessionId: artifact.sessionId,
    container: artifact.container,
    role: artifact.role,
    title: artifact.title,
    finalPath: workDir ? artifactCanonicalToDisplayPath(workDir, artifact.canonicalPath) : artifact.canonicalPath,
    status: artifact.status,
    ...(artifact.stage ? { stage: artifact.stage } : {}),
    ...(artifact.packageId ? { packageId: artifact.packageId } : {})
  }
}

export function createArtifactIpcHandlers(deps: ArtifactIpcDeps) {
  const repository = () => new ArtifactRepository(deps.db)

  return {
    list(payload: { sessionId?: string }): ArtifactApiItem[] {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (!sessionId) return []
      const session = getSession(deps.db, sessionId)
      if (!session || session.workDirProfileId !== deps.getActiveProfileId()) return []
      const workspace = resolveArtifactMutationWorkspace({
        db: deps.db,
        sessionId,
        profiles: deps.getProfiles()
      })
      const workDir = workspace.ok ? workspace.workDir : ''
      return repository()
        .listBySession(sessionId)
        .map((artifact) => toApiItem(artifact, workDir))
    },

    async delete(payload: { sessionId?: string; artifactId?: string }): Promise<{ ok: boolean; error?: string }> {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      const artifactId = typeof payload?.artifactId === 'string' ? payload.artifactId.trim() : ''
      if (!sessionId || !artifactId) return { ok: false, error: ErrorCodes.ARTIFACT_WORKSPACE_UNAVAILABLE }
      const artifact = repository().find(artifactId)
      if (!artifact || artifact.status !== 'active') return { ok: false, error: 'Artifact not found' }
      const workspace = resolveArtifactMutationWorkspace({
        db: deps.db,
        sessionId,
        profiles: deps.getProfiles(),
        artifact
      })
      if (!workspace.ok) return { ok: false, error: workspace.errorCode }
      try {
        const targetPath = path.isAbsolute(artifact.canonicalPath)
          ? artifact.canonicalPath
          : path.resolve(workspace.workDir, artifact.canonicalPath)
        await deleteArtifactFile({
          registry: getSharedArtifactPathLeaseRegistry(),
          identity: artifactDeleteLeaseIdentity(artifact.workspaceRootReal, artifact.pathIdentityKey),
          targetPath,
          workDir: workspace.workDir,
          expectedWorkspaceRootReal: artifact.workspaceRootReal,
          artifactId: artifact.id,
          repository: repository()
        })
        deps.notifyChanged({ sessionId, artifactId, action: 'deleted' })
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/lease/i.test(message)) return { ok: false, error: message }
        if (message.includes(ErrorCodes.ARTIFACT_WORKSPACE_CHANGED)) return { ok: false, error: message }
        return { ok: false, error: message }
      }
    },

    async cleanSession(payload: { sessionId?: string; includeReferences?: boolean }): Promise<{
      deleted: string[]
      skipped: Array<{ artifactId: string; reason: string }>
    }> {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (!sessionId) return { deleted: [], skipped: [] }
      const workspace = resolveArtifactMutationWorkspace({
        db: deps.db,
        sessionId,
        profiles: deps.getProfiles()
      })
      if (!workspace.ok) return { deleted: [], skipped: [] }
      const result = await cleanArtifactSession({
        repository: repository(),
        registry: getSharedArtifactPathLeaseRegistry(),
        sessionId,
        workDir: workspace.workDir,
        includeReferences: payload.includeReferences === true
      })
      for (const id of result.deleted) deps.notifyChanged({ sessionId, artifactId: id, action: 'deleted' })
      return {
        deleted: result.deleted,
        skipped: result.skipped.map((item) => ({ artifactId: item.id, reason: item.reason }))
      }
    },

    decisionResponse(payload: ArtifactDecisionResponsePayload): void {
      if (payload.choice.startsWith('rename:')) {
        validateDecisionRename(payload.choice.slice('rename:'.length))
      } else if (payload.choice.startsWith('change-directory:')) {
        validateDecisionDirectory(payload.choice.slice('change-directory:'.length))
      }
      submitArtifactDecisionResponse(payload)
    },

    setDefaultDir(payload: { sessionId?: string; dir?: string }): void {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      const dir = typeof payload?.dir === 'string' ? validateDecisionDirectory(payload.dir) : ''
      if (!sessionId || !dir) throw new Error('Invalid artifact default directory')
      const workspace = resolveArtifactMutationWorkspace({
        db: deps.db,
        sessionId,
        profiles: deps.getProfiles()
      })
      if (!workspace.ok) throw new Error(workspace.errorCode)
      updateSession(deps.db, sessionId, {
        metadata: {
          ...(getSession(deps.db, sessionId)?.metadata ?? {}),
          artifactDefaultDir: dir
        }
      })
    },

    async relocate(payload: {
      sessionId?: string
      artifactId?: string
      target?: string
      mode?: 'move' | 'copy'
      switchToCopy?: boolean
      overwriteAuthorized?: boolean
    }): Promise<{ ok: boolean; error?: string; artifactId?: string; activeArtifactId?: string }> {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      const artifactId = typeof payload?.artifactId === 'string' ? payload.artifactId.trim() : ''
      const target = typeof payload?.target === 'string' ? validateDecisionDirectory(payload.target).replace(/\\/g, '/') : ''
      const mode = payload?.mode === 'copy' ? 'copy' : payload?.mode === 'move' ? 'move' : ''
      if (!sessionId || !artifactId || !target || !mode) return { ok: false, error: ErrorCodes.ARTIFACT_WORKSPACE_UNAVAILABLE }
      const artifact = repository().find(artifactId)
      if (!artifact || artifact.sessionId !== sessionId) return { ok: false, error: 'Artifact not found' }
      const workspace = resolveArtifactMutationWorkspace({
        db: deps.db,
        sessionId,
        profiles: deps.getProfiles(),
        artifact
      })
      if (!workspace.ok) return { ok: false, error: workspace.errorCode }
      const result = await relocateArtifact(
        { db: deps.db, profiles: deps.getProfiles(), registry: getSharedArtifactPathLeaseRegistry() },
        {
          sessionId,
          artifactId,
          target,
          mode,
          switchToCopy: payload.switchToCopy === true,
          overwriteAuthorized: payload.overwriteAuthorized === true
        }
      )
      if (result.ok) {
        deps.notifyChanged({ sessionId, artifactId: result.artifactId, action: result.artifactId === artifactId ? 'updated' : 'created' })
      }
      return result
    },

    recentContext(sessionId: string): ArtifactContextSummary[] {
      return buildArtifactContextSummaries(repository(), sessionId)
    }
  }
}

export function emitArtifactChanged(
  win: BrowserWindow | null | undefined,
  event: { sessionId: string; artifactId: string; action: 'created' | 'updated' | 'deleted' }
): void {
  win?.webContents.send('artifact:changed', event)
}

export function artifactCanonicalToDisplayPath(workDir: string, canonicalPath: string): string {
  if (!path.isAbsolute(canonicalPath)) return canonicalPath.replace(/\\/g, '/')
  const relative = path.relative(workDir, canonicalPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return canonicalPath
  return relative.split(path.sep).join('/')
}
