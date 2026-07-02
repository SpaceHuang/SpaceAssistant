import path from 'path'
import type { WriteDirChoice } from './writeDirConfirmRegistry'
import { getConfigValue, getSession, listSessions, updateSession, type AppDatabase } from '../database'
import type { Session } from '../../src/shared/domainTypes'

const KEY = 'writeDirChoice'
const ACTIVE_PROFILE_KEY = 'config.activeWorkDirProfileId'

export function getWriteDirChoice(metadata: Record<string, unknown>): WriteDirChoice {
  const v = metadata[KEY]
  if (v && typeof v === 'object' && 'dir' in v && typeof (v as { dir: unknown }).dir === 'string') {
    const confirmedAt = (v as { confirmedAt?: unknown }).confirmedAt
    return {
      dir: (v as { dir: string }).dir,
      confirmedAt: typeof confirmedAt === 'number' ? confirmedAt : Date.now()
    }
  }
  return null
}

export function setWriteDirChoice(metadata: Record<string, unknown>, choice: WriteDirChoice): void {
  if (choice) {
    metadata[KEY] = { ...choice }
  } else {
    delete metadata[KEY]
  }
}

export function clearWriteDirChoice(metadata: Record<string, unknown>): void {
  delete metadata[KEY]
}

export function clearAllSessionsWriteDirChoices(db: AppDatabase): void {
  for (const s of listSessions(db)) {
    const meta = { ...s.metadata }
    if (getWriteDirChoice(meta)) {
      clearWriteDirChoice(meta)
      updateSession(db, s.id, { metadata: meta })
    }
  }
}

export function isSessionInSameWorkspace(
  session: Session,
  workDirProfileId: string,
  activeProfileId: string
): boolean {
  if (session.workDirProfileId) {
    return session.workDirProfileId === workDirProfileId
  }
  return workDirProfileId === activeProfileId
}

function isDirUnderWorkDir(dir: string, workDir: string): boolean {
  const resolved = path.resolve(dir)
  const root = path.resolve(workDir)
  const rel = path.relative(root, resolved)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 当前工作区内（同 workDir profile）、除当前会话外，最近一次确认的写入目录 */
export function findLatestWriteDirChoiceInWorkspace(
  db: AppDatabase,
  args: {
    workDirProfileId: string
    activeProfileId: string
    excludeSessionId: string
    workDir: string
  }
): WriteDirChoice | null {
  const { workDirProfileId, activeProfileId, excludeSessionId, workDir } = args
  let best: WriteDirChoice | null = null

  for (const session of listSessions(db)) {
    if (session.id === excludeSessionId) continue
    if (!isSessionInSameWorkspace(session, workDirProfileId, activeProfileId)) continue
    const choice = getWriteDirChoice(session.metadata)
    if (!choice) continue
    if (!isDirUnderWorkDir(choice.dir, workDir)) continue
    if (!best || choice.confirmedAt > best.confirmedAt) {
      best = choice
    }
  }

  return best
}

export function resolveWorkspaceProfileIds(
  db: AppDatabase,
  sessionId: string
): { workDirProfileId: string; activeProfileId: string } {
  const activeProfileId = getConfigValue(db, ACTIVE_PROFILE_KEY) ?? ''
  const session = getSession(db, sessionId)
  const workDirProfileId = session?.workDirProfileId ?? activeProfileId
  return { workDirProfileId, activeProfileId }
}
