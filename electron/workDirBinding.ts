import type { WorkDirProfile } from '../src/shared/feishuTypes'
import type { AppDatabase } from './database'
import { getSession, updateSession } from './database'
import { isRequestLeaseOwner } from './remote/remoteAgentRegistry'
import { REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE } from './remote/remoteSessionGuardMessages'
import type { WorkDirManager } from './workDirManager'
import type { RemoteContext } from './tools/types'

export const SENSITIVE_WORKDIR_ERROR = '该工作目录为敏感目录，不允许远程访问'

export interface BindSessionWorkDirParams {
  sessionId: string
  profileId: string
  remoteContext: RemoteContext
  source: 'inbound' | 'tool'
  /** requestId of the caller; only the Agent holding the origin lease may rebind via 'tool'. */
  requestId?: string
  appendAudit?: (profileId: string, profileName: string) => void | Promise<void>
}

export interface BindSessionWorkDirResult {
  success: boolean
  error?: string
  changed?: boolean
}

export interface MatchWorkDirInput {
  profile_id?: string
  name?: string
  alias?: string
}

export interface MatchWorkDirResult {
  matches: WorkDirProfile[]
  error?: string
}

export function normalizeWorkDirHint(s: string): string {
  return s.trim().toLowerCase()
}

export function matchWorkDirProfile(input: MatchWorkDirInput, profiles: WorkDirProfile[]): MatchWorkDirResult {
  const profileId = typeof input.profile_id === 'string' ? input.profile_id.trim() : ''
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const alias = typeof input.alias === 'string' ? input.alias.trim() : ''

  if (!profileId && !name && !alias) {
    return { matches: [], error: '至少提供 profile_id、name 或 alias 中的一个' }
  }

  if (profileId) {
    return { matches: profiles.filter((p) => p.id === profileId) }
  }

  if (name) {
    const normalizedName = normalizeWorkDirHint(name)
    const exactMatches = profiles.filter((p) => normalizeWorkDirHint(p.name) === normalizedName)
    if (exactMatches.length > 0) {
      return { matches: exactMatches }
    }
    return { matches: profiles.filter((p) => normalizeWorkDirHint(p.name).includes(normalizedName)) }
  }

  const normalizedAlias = normalizeWorkDirHint(alias)
  return {
    matches: profiles.filter((p) =>
      (p.aliases ?? []).some((a) => normalizeWorkDirHint(a) === normalizedAlias)
    )
  }
}

export async function writeWorkDirSwitchAudit(
  remoteContext: RemoteContext,
  profileId: string,
  profileName: string
): Promise<void> {
  if (remoteContext.appendWorkDirSwitchAudit) {
    await remoteContext.appendWorkDirSwitchAudit(profileId, profileName)
  }
}

export function canBindSessionWorkDir(
  db: AppDatabase,
  sessionId: string,
  profileId: string,
  source: 'inbound' | 'tool',
  requestId?: string
): { allowed: boolean; error?: string } {
  if (source === 'inbound') {
    return { allowed: true }
  }

  const session = getSession(db, sessionId)
  if (!session) {
    return { allowed: false, error: '会话不存在' }
  }

  if (session.workDirProfileId === profileId) {
    return { allowed: true }
  }

  // Only the Agent whose requestId currently holds the origin lease may rebind its own
  // session's workDir; missing/wrong/expired lease is busy.
  if (!requestId || !isRequestLeaseOwner(sessionId, requestId)) {
    return { allowed: false, error: REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE }
  }

  return { allowed: true }
}

export async function bindSessionWorkDir(
  db: AppDatabase,
  workDirManager: WorkDirManager,
  params: BindSessionWorkDirParams
): Promise<BindSessionWorkDirResult> {
  const session = getSession(db, params.sessionId)
  if (!session) {
    return { success: false, error: '会话不存在' }
  }

  const guard = canBindSessionWorkDir(db, params.sessionId, params.profileId, params.source, params.requestId)
  if (!guard.allowed) {
    return { success: false, error: guard.error }
  }

  const profiles = workDirManager.listProfiles()
  const profile = profiles.find((p) => p.id === params.profileId)
  if (!profile) {
    return { success: false, error: '工作目录配置不存在' }
  }

  if (profile.sensitive === true) {
    return { success: false, error: SENSITIVE_WORKDIR_ERROR }
  }

  const writable = workDirManager.checkDirectoryWritable(profile.path)
  if (!writable.ok) {
    return { success: false, error: writable.error ? `无法写入该目录：${writable.error}` : '无法写入该目录' }
  }

  if (session.workDirProfileId === params.profileId) {
    return { success: true, changed: false }
  }

  updateSession(db, params.sessionId, { workDirProfileId: params.profileId })

  const auditWriter = params.appendAudit ?? params.remoteContext.appendWorkDirSwitchAudit
  if (auditWriter) {
    await auditWriter(params.profileId, profile.name)
  } else {
    await writeWorkDirSwitchAudit(params.remoteContext, params.profileId, profile.name)
  }

  return { success: true, changed: true }
}
