import type { WorkDirProfile } from '../../src/shared/feishuTypes'
import { resolveWorkDirForSession } from '../workDirManager'
import {
  SENSITIVE_WORKDIR_ERROR,
  bindSessionWorkDir,
  matchWorkDirProfile
} from '../workDirBinding'
import type { ToolExecutionContext, ToolExecutor } from './types'

const REMOTE_ONLY_ERROR = '该工具仅在远程会话中可用'
const MISSING_CONTEXT_ERROR = '缺少必要的上下文信息'

export const listWorkDirsExecutor: ToolExecutor = {
  name: 'list_work_dirs',
  async execute(_input, ctx) {
    if (!ctx.remoteContext) {
      return { success: false, error: REMOTE_ONLY_ERROR }
    }

    const { workDirManager, sessionId, appDatabase } = ctx
    if (!workDirManager || !appDatabase) {
      return { success: false, error: MISSING_CONTEXT_ERROR }
    }

    const profiles = workDirManager.listProfiles()
    const activeProfileId = workDirManager.getActiveProfileId()
    const resolved = resolveWorkDirForSession(
      appDatabase,
      sessionId,
      () => profiles,
      () => activeProfileId,
      workDirManager.getActiveWorkDir.bind(workDirManager)
    )
    const currentBoundId = resolved?.profileId ?? ''

    return {
      success: true,
      data: {
        directories: profiles.map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
          isBound: p.id === currentBoundId,
          isDefault: Boolean(p.isDefault),
          isActive: p.id === activeProfileId,
          isSensitive: Boolean(p.sensitive),
          aliases: p.aliases ?? []
        })),
        currentBoundId,
        activeProfileId
      }
    }
  }
}

export const switchWorkDirExecutor: ToolExecutor = {
  name: 'switch_work_dir',
  async execute(input, ctx) {
    if (!ctx.remoteContext) {
      return { success: false, error: REMOTE_ONLY_ERROR }
    }

    const { workDirManager, sessionId, appDatabase, remoteContext } = ctx
    if (!workDirManager || !appDatabase) {
      return { success: false, error: MISSING_CONTEXT_ERROR }
    }

    const profiles = workDirManager.listProfiles()
    const matchResult = matchWorkDirProfile(
      {
        profile_id: input.profile_id as string | undefined,
        name: input.name as string | undefined,
        alias: input.alias as string | undefined
      },
      profiles
    )

    if (matchResult.error) {
      return { success: false, error: matchResult.error }
    }

    if (matchResult.matches.length === 0) {
      return { success: false, error: '未找到匹配的工作目录' }
    }

    if (matchResult.matches.length > 1) {
      return {
        success: false,
        data: {
          ambiguous: matchResult.matches.map((p: WorkDirProfile) => ({
            id: p.id,
            name: p.name,
            aliases: p.aliases ?? []
          }))
        }
      }
    }

    const targetProfile = matchResult.matches[0]!
    if (targetProfile.sensitive === true) {
      return { success: false, error: SENSITIVE_WORKDIR_ERROR }
    }

    const bindResult = await bindSessionWorkDir(appDatabase, workDirManager, {
      sessionId,
      profileId: targetProfile.id,
      remoteContext,
      source: 'tool'
    })

    if (!bindResult.success) {
      return { success: false, error: bindResult.error }
    }

    return {
      success: true,
      data: {
        profileId: targetProfile.id,
        profileName: targetProfile.name,
        workDir: targetProfile.path
      }
    }
  }
}
