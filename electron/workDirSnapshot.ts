import fs from 'fs'

import type { WorkspaceSnapshot } from '../src/shared/agent/workspace'
import { normalizeWorkspaceRoot, workspacePathKey } from '../src/shared/agent/workspace'
import type { AppDatabase } from './database'
import { getSession } from './database'
import type { WorkDirManager } from './workDirManager'
import { resolveWorkDirForSession } from './workDirManager'

function realpathBestEffort(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

function buildSnapshot(input: {
  profileId: string
  workDir: string
  sensitive: boolean
  source: WorkspaceSnapshot['source']
  revision: number
}): WorkspaceSnapshot {
  const rootPath = normalizeWorkspaceRoot(realpathBestEffort(input.workDir))
  return {
    profileId: input.profileId,
    rootPath,
    key: workspacePathKey(rootPath),
    source: input.source,
    sensitive: input.sensitive,
    revision: input.revision,
  }
}

/**
 * 装配期把「会话工作目录」解析为单一事实源快照。
 * 包装既有 resolveWorkDirForSession：不新增读库路径之外的事实来源。
 */
export function resolveWorkspaceSnapshot(
  db: AppDatabase | undefined,
  sessionId: string,
  workDirManager: WorkDirManager | undefined,
  fallbackWorkDir: string
): WorkspaceSnapshot | null {
  if (!workDirManager || !db) return null
  const session = getSession(db, sessionId)
  const resolved = resolveWorkDirForSession(
    db,
    sessionId,
    () => workDirManager.listProfiles(),
    () => workDirManager.getActiveProfileId(),
    () => workDirManager.getActiveWorkDir()
  )
  if (!resolved) return null
  const boundBySession = Boolean(session?.workDirProfileId) && resolved.profileId === session?.workDirProfileId
  return buildSnapshot({
    profileId: resolved.profileId,
    workDir: resolved.workDir,
    sensitive: Boolean(resolved.isSensitive),
    source: boundBySession ? 'session-binding' : 'active-fallback',
    revision: 0,
  })
}

export interface WorkspaceReboundEvent {
  sessionId: string
  fromProfileId: string
  toProfileId: string
  revision: number
}

export interface WorkspaceSnapshotTracker {
  /** 装配期解析后的快照；回合内取用不重算 */
  snapshot(): WorkspaceSnapshot
  /** 调用边界刷新：绑定未变返回原快照对象；变了产新快照（revision+1）并触发 onRebound */
  refresh(): WorkspaceSnapshot
}

/**
 * 「调用内冻结、调用间跟随」的载体：toolChatLoop 在每次工具调用边界调用 refresh()。
 * 未变（workspacePathKey 相同）→ 返回原快照对象，不递增 revision、不落审计。
 */
export function createWorkspaceSnapshotTracker(opts: {
  db: AppDatabase | undefined
  sessionId: string
  workDirManager: WorkDirManager | undefined
  fallbackWorkDir: string
  onRebound?: (e: WorkspaceReboundEvent) => void
}): WorkspaceSnapshotTracker {
  let current: WorkspaceSnapshot = fallbackSnapshot(opts.fallbackWorkDir)
  const resolved = resolveWorkspaceSnapshot(opts.db, opts.sessionId, opts.workDirManager, opts.fallbackWorkDir)
  if (resolved) current = resolved

  function fallbackSnapshot(workDir: string): WorkspaceSnapshot {
    return buildSnapshot({
      profileId: '',
      workDir,
      sensitive: false,
      source: 'active-fallback',
      revision: 0,
    })
  }

  return {
    snapshot: () => current,
    refresh: () => {
      const next =
        resolveWorkspaceSnapshot(opts.db, opts.sessionId, opts.workDirManager, opts.fallbackWorkDir) ??
        fallbackSnapshot(opts.fallbackWorkDir)
      if (next.key === current.key) {
        return current
      }
      const rebound: WorkspaceSnapshot = { ...next, revision: current.revision + 1 }
      const previous = current
      current = rebound
      opts.onRebound?.({
        sessionId: opts.sessionId,
        fromProfileId: previous.profileId,
        toProfileId: rebound.profileId,
        revision: rebound.revision,
      })
      return rebound
    },
  }
}
