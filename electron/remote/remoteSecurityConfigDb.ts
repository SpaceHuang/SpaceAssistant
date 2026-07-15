/**
 * Atomic commit of the remote-security summary selection.
 *
 * Writes the shared common security fields (+ version + preset source) to BOTH the feishu and
 * wechat stored configs, plus feishu's larkCliWriteRequiresConfirm, inside a single DB
 * transaction. Any failure rolls back everything, so the config version is never advanced
 * partially (§2.3.3 atomic requirement). No per-field renderer saves.
 */
import type { AppDatabase } from '../database'
import { getConfigValue, runInTransaction, setConfigValue } from '../database'
import { mergeFeishuConfig, type FeishuConfig } from '../../src/shared/feishuTypes'
import { mergeWeChatConfig, type WeChatConfig } from '../../src/shared/wechatTypes'
import type {
  RemoteSecurityCommitResult,
  RemoteSecurityPatch
} from '../../src/shared/remoteSecurityMigration'

const FEISHU_CONFIG_KEY = 'config.feishu'
const WECHAT_CONFIG_KEY = 'config.wechat'

/** Test-only fault-injection hooks (default no-ops). */
export interface CommitHooks {
  beforeFeishuWrite?: () => void
  beforeWeChatWrite?: () => void
  afterWrites?: () => void
}

function readRawFeishu(db: AppDatabase): Partial<FeishuConfig> {
  const raw = getConfigValue(db, FEISHU_CONFIG_KEY)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Partial<FeishuConfig>
  } catch {
    return {}
  }
}

function readRawWeChat(db: AppDatabase): Partial<WeChatConfig> {
  const raw = getConfigValue(db, WECHAT_CONFIG_KEY)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Partial<WeChatConfig>
  } catch {
    return {}
  }
}

export type CommitResult = RemoteSecurityCommitResult

/**
 * Atomically apply the security patch to both channels. Returns the merged configs.
 * Throws (and rolls back) if any write or injected hook fails.
 */
export function commitRemoteSecurityConfig(
  db: AppDatabase,
  patch: RemoteSecurityPatch,
  hooks: CommitHooks = {}
): CommitResult {
  return runInTransaction(db, () => {
    const feishuRaw = readRawFeishu(db)
    const wechatRaw = readRawWeChat(db)

    const nextFeishu = mergeFeishuConfig({
      ...feishuRaw,
      ...patch.common,
      larkCliWriteRequiresConfirm: patch.feishu.larkCliWriteRequiresConfirm
    })
    const nextWeChat = mergeWeChatConfig({
      ...wechatRaw,
      ...patch.common
    })

    hooks.beforeFeishuWrite?.()
    setConfigValue(db, FEISHU_CONFIG_KEY, JSON.stringify(nextFeishu))
    hooks.beforeWeChatWrite?.()
    setConfigValue(db, WECHAT_CONFIG_KEY, JSON.stringify(nextWeChat))
    hooks.afterWrites?.()

    return { feishu: nextFeishu, wechat: nextWeChat }
  })
}
