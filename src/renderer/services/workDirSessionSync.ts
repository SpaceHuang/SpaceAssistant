import type { AppConfig, Session } from '../../shared/domainTypes'
import type { WorkDirProfile } from '../../shared/feishuTypes'
import type { AppDispatch } from '../store'
import { setConfig } from '../store/configSlice'
import { setSessions } from '../store/sessionSlice'

/** 保存设置时保留当前 active 工作区；仅当 active 已被删除时回退到默认 */
export function resolveWorkDirProfileForSave(
  profiles: WorkDirProfile[],
  currentActiveId: string | undefined
): WorkDirProfile | undefined {
  if (profiles.length === 0) return undefined
  const byActive = currentActiveId ? profiles.find((p) => p.id === currentActiveId) : undefined
  return byActive ?? profiles.find((p) => p.isDefault) ?? profiles[0]
}

export function activeWorkDirProfileId(config: AppConfig): string {
  return (
    config.activeWorkDirProfileId ??
    config.workDirProfiles?.find((p) => p.isDefault)?.id ??
    ''
  )
}

export function sessionNeedsWorkDirSwitch(session: Session, config: AppConfig): boolean {
  const profileId = session.workDirProfileId
  if (!profileId) return false
  return profileId !== activeWorkDirProfileId(config)
}

export type EnsureWorkDirResult =
  | { ok: true; switched: boolean; committed: boolean }
  | { ok: false; error: string }

export type EnsureWorkDirOptions = {
  /** 返回 false 表示本请求已被后发切换取代；不得再向 store 提交 setConfig/setSessions */
  isCurrent?: () => boolean
}

async function switchWorkDirProfile(
  profileId: string,
  dispatch: AppDispatch,
  opts?: EnsureWorkDirOptions
): Promise<EnsureWorkDirResult> {
  const result = await window.api.workdirSwitch(profileId)
  if (!result.success) {
    return { ok: false, error: result.error ?? '切换工作目录失败' }
  }

  // 主进程已切到目标；若已被取代，不把旧结果写进 renderer store（由调用方按需补偿回滚）。
  if (opts?.isCurrent && !opts.isCurrent()) {
    return { ok: true, switched: true, committed: false }
  }

  const nextConfig = await window.api.configGet()
  if (opts?.isCurrent && !opts.isCurrent()) {
    return { ok: true, switched: true, committed: false }
  }

  dispatch(setConfig(nextConfig))
  dispatch(setSessions(result.sessions))
  return { ok: true, switched: true, committed: true }
}

/** 将会话所属 Profile 切换为 active；成功时更新 config 与 session 列表 */
export async function ensureWorkDirForSession(
  session: Session,
  config: AppConfig,
  dispatch: AppDispatch,
  opts?: EnsureWorkDirOptions
): Promise<EnsureWorkDirResult> {
  const profileId = session.workDirProfileId
  if (!profileId || profileId === activeWorkDirProfileId(config)) {
    return { ok: true, switched: false, committed: false }
  }
  return switchWorkDirProfile(profileId, dispatch, opts)
}

/**
 * 撤销之前的工作目录切换：切回 `previousProfileId`。
 * 最佳努力执行——回滚失败时不抛出。
 */
export async function rollbackWorkDirProfile(
  previousProfileId: string,
  dispatch: AppDispatch
): Promise<boolean> {
  if (!previousProfileId) return false
  try {
    const result = await switchWorkDirProfile(previousProfileId, dispatch)
    return result.ok
  } catch {
    return false
  }
}
