import type { AppConfig, Session } from '../../shared/domainTypes'
import type { AppDispatch } from '../store'
import { setConfig } from '../store/configSlice'
import { setSessions } from '../store/sessionSlice'

function activeProfileId(config: AppConfig): string {
  return (
    config.activeWorkDirProfileId ??
    config.workDirProfiles?.find((p) => p.isDefault)?.id ??
    ''
  )
}

export function sessionNeedsWorkDirSwitch(session: Session, config: AppConfig): boolean {
  const profileId = session.workDirProfileId
  if (!profileId) return false
  return profileId !== activeProfileId(config)
}

export type EnsureWorkDirResult =
  | { ok: true; switched: boolean }
  | { ok: false; error: string }

/** 将会话所属 Profile 切换为 active；成功时更新 config 与 session 列表 */
export async function ensureWorkDirForSession(
  session: Session,
  config: AppConfig,
  dispatch: AppDispatch
): Promise<EnsureWorkDirResult> {
  const profileId = session.workDirProfileId
  if (!profileId || profileId === activeProfileId(config)) {
    return { ok: true, switched: false }
  }

  const result = await window.api.workdirSwitch(profileId)
  if (!result.success) {
    return { ok: false, error: result.error ?? '切换工作目录失败' }
  }

  const nextConfig = await window.api.configGet()
  dispatch(setConfig(nextConfig))
  dispatch(setSessions(result.sessions))
  return { ok: true, switched: true }
}
