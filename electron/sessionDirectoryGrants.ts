import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Session } from '../src/shared/domainTypes'
import { isPathWithinGrantedDirectory, normalizeDirectoryGrantPath, toSessionDirectoryGrantView, type SessionDirectoryGrantRecord, type SessionDirectoryGrantView } from '../src/shared/sessionDirectoryGrant'

const METADATA_KEY = 'sessionDirectoryGrants'
export type SessionDirectoryGrantStatus = SessionDirectoryGrantView & { status: 'valid' | 'invalid' }
export type AddSessionDirectoryGrantResult =
  | { status: 'added' | 'already-granted'; grant: SessionDirectoryGrantView }
  | { status: 'canceled' | 'invalid-directory' | 'sensitive-directory' }

function readRecords(session: Pick<Session, 'id' | 'metadata'>): SessionDirectoryGrantRecord[] {
  const value = session.metadata?.[METADATA_KEY]
  if (!Array.isArray(value)) return []
  return value.filter((record): record is SessionDirectoryGrantRecord =>
    Boolean(record && typeof record === 'object' &&
      typeof (record as SessionDirectoryGrantRecord).grantId === 'string' &&
      (record as SessionDirectoryGrantRecord).sessionId === session.id &&
      typeof (record as SessionDirectoryGrantRecord).realPath === 'string' &&
      (record as SessionDirectoryGrantRecord).identity &&
      (record as SessionDirectoryGrantRecord).source === 'user-selected-directory')
  )
}

export async function addSessionDirectoryGrant(input: {
  session: Session
  selectDirectory: () => Promise<string | undefined>
  updateSession: (session: Session) => void
  isSensitivePath: (realPath: string) => boolean | Promise<boolean>
}): Promise<AddSessionDirectoryGrantResult> {
  const selectedPath = await input.selectDirectory()
  if (!selectedPath) return { status: 'canceled' }
  try {
    const realPath = await fs.realpath(selectedPath)
    const stat = await fs.stat(realPath)
    if (!stat.isDirectory()) return { status: 'invalid-directory' }
    if (await input.isSensitivePath(realPath)) return { status: 'sensitive-directory' }
    const normalized = normalizeDirectoryGrantPath(realPath)
    const existing = readRecords(input.session).find((record) =>
      record.sessionId === input.session.id && normalizeDirectoryGrantPath(record.realPath) === normalized && isPathWithinGrantedDirectory(record.realPath, realPath)
    )
    if (existing) {
      const existingStat = await fs.stat(existing.realPath).catch(() => undefined)
      if (existingStat?.isDirectory() && existingStat.dev === existing.identity.dev && existingStat.ino === existing.identity.ino && existingStat.mode === existing.identity.mode) {
        return { status: 'already-granted', grant: toSessionDirectoryGrantView(existing) }
      }
    }
    const record: SessionDirectoryGrantRecord = {
      grantId: randomUUID(),
      sessionId: input.session.id,
      path: realPath,
      realPath,
      identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode },
      createdAt: Date.now(),
      source: 'user-selected-directory'
    }
    input.updateSession({
      ...input.session,
      metadata: { ...input.session.metadata, [METADATA_KEY]: [...readRecords(input.session).filter((item) => item.grantId !== existing?.grantId), record] }
    })
    return { status: 'added', grant: toSessionDirectoryGrantView(record) }
  } catch {
    return { status: 'invalid-directory' }
  }
}

export async function listSessionDirectoryGrants(session: Session): Promise<SessionDirectoryGrantStatus[]> {
  return Promise.all(readRecords(session).map(async (record) => {
    let valid = false
    try {
      const realPath = await fs.realpath(record.path)
      const stat = await fs.stat(realPath)
      valid = stat.isDirectory() && normalizeDirectoryGrantPath(realPath) === normalizeDirectoryGrantPath(record.realPath) &&
        stat.dev === record.identity.dev && stat.ino === record.identity.ino && stat.mode === record.identity.mode
    } catch { /* 缺失、权限错误或身份变化均 fail-closed */ }
    return { ...toSessionDirectoryGrantView(record), status: valid ? 'valid' : 'invalid' }
  }))
}

export function removeSessionDirectoryGrant(input: {
  session: Session
  grantId: string
  updateSession: (session: Session) => void
}): boolean {
  const records = readRecords(input.session)
  const remaining = records.filter((record) => record.grantId !== input.grantId || record.sessionId !== input.session.id)
  if (remaining.length === records.length) return false
  input.updateSession({ ...input.session, metadata: { ...input.session.metadata, [METADATA_KEY]: remaining } })
  return true
}

/** Synchronous invocation snapshot: stale, missing, replaced and session-mismatched roots are omitted. */
export function listValidSessionDirectoryGrantsSync(session: Pick<Session, 'id' | 'metadata'>): SessionDirectoryGrantRecord[] {
  return readRecords(session).filter((record) => {
    try {
      const realPath = fsSync.realpathSync(record.path)
      const stat = fsSync.statSync(realPath)
      return stat.isDirectory() && normalizeDirectoryGrantPath(realPath) === normalizeDirectoryGrantPath(record.realPath) &&
        stat.dev === record.identity.dev && stat.ino === record.identity.ino && stat.mode === record.identity.mode
    } catch { return false }
  })
}
