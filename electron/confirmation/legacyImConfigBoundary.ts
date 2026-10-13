import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../database'
import { getConfigValue } from '../database'
import { getDbConnection } from '../database'
import { commitImPolicySnapshot, readImPolicySnapshot } from './imPolicyStore'
import { planLegacyImPolicyMigration } from '../../src/shared/policy/legacyPolicyMigration'

const SUPPORTED_IM_POLICY_VERSIONS = ['im-v1.6', 'im-standard-v2'] as const
const CHANNEL_POLICY_KEYS = [
  'remoteConfirmPolicy', 'remoteAllowLocalWrite', 'remoteDenyOutbound',
  'remoteBrowserRequiresConfirm', 'remoteBrowserNavigateRequiresConfirm', 'remoteBrowserActRequiresConfirm',
  'remoteScriptRequiresConfirm', 'remoteSecurityConfigVersion', 'remoteSecurityPresetSource',
  'larkCliWriteRequiresConfirm', 'wechatSendRequiresConfirm'
] as const

function readRawChannelConfig(db: AppDatabase, key: string): Record<string, unknown> | undefined {
  const raw = getConfigValue(db, key)
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid legacy channel config JSON: ${key}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid legacy channel config: ${key}`)
  return parsed as Record<string, unknown>
}

/** Ensure legacy IM authorization settings are represented by the frozen snapshot before runtime dispatch starts. */
export function ensureImPolicySnapshotAtStartup(db: AppDatabase): void {
  migrateLegacyImConfigBeforeChannelWrite(db)
}

/** Migrate the raw channel policy exactly once, then remove policy-owned keys from its JSON projection. */
export function migrateLegacyImConfigBeforeChannelWrite(db: AppDatabase): void {
  const conn = getDbConnection(db)
  const existing = conn.prepare("SELECT 1 FROM policy_behavior_snapshots WHERE domain='im'").get()
  if (existing) {
    readImPolicySnapshot(conn, { supportedBehaviorVersions: SUPPORTED_IM_POLICY_VERSIONS })
    return
  }

  const wechat = readRawChannelConfig(db, 'config.wechat')
  const feishu = readRawChannelConfig(db, 'config.feishu')
  if (!wechat && !feishu) return
  const plan = planLegacyImPolicyMigration({ wechat, feishu })
  if (plan.status !== 'migrate') return
  const result = commitImPolicySnapshot(conn, {
    policyBehaviorVersion: plan.policyBehaviorVersion,
    snapshot: plan.snapshot,
    updatedAt: Date.now(),
    eventId: randomUUID(),
    eventKind: 'legacy-policy-migrated'
  })
  if (result.status === 'conflict') throw new Error('IM policy migration revision conflict')
}

export function stripChannelPolicyFields<T extends Record<string, unknown>>(config: T): T {
  const sanitized = { ...config }
  for (const key of CHANNEL_POLICY_KEYS) delete sanitized[key]
  return sanitized
}
