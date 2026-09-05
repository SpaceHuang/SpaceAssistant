import type {
  CacheKey,
  DecisionCacheEntry,
  Decision,
  ExecutionLane,
  MemoryTier,
  OriginInfo
} from '../../src/shared/confirmation/types'
import { getDbConnection, type AppDatabase } from '../database'
import { AuditedDecisionCache } from './auditedDecisionCache'
import { SqliteDecisionCache, canonicalKeyJson } from './sqliteDecisionCache'
import type { AuditSink } from './channels'
import { ConfirmationAuthorizationRegistry, type MemoryWritePermit, type MemoryWritePermitSubject } from './confirmationAuthorizationRegistry'

/** execute 类（shell 命令）记忆 TTL：90 天（§5.3 TTL 按风险分级）。 */
const EXECUTE_MEMORY_TTL_MS = 90 * 24 * 3600 * 1000

/** 远程写会话信任 TTL：30 分钟（B3：等价旧 RemoteWriteGrant 租约期，不得无限期存活）。 */
const REMOTE_WRITE_MEMORY_TTL_MS = 30 * 60 * 1000

/** 按缓存键推导写入用的 TTL（execute 类 90 天，remote-write 30 分钟，其余无 TTL）。 */
function expiresAtForKey(key: CacheKey, now: number): number | undefined {
  if (key.kind === 'shell-command') return now + EXECUTE_MEMORY_TTL_MS
  if (key.kind === 'remote-write') return now + REMOTE_WRITE_MEMORY_TTL_MS
  return undefined
}

/** 按缓存键推导记忆范围：绑定 sessionId 的键为会话级，其余持久。 */
export function scopeForCacheKey(key: CacheKey): 'session' | 'persistent' {
  return 'sessionId' in key && key.sessionId ? 'session' : 'persistent'
}

export interface RecordUserAnswerArgs {
  db: AppDatabase
  audit?: AuditSink
  lane: ExecutionLane
  sessionId: string
  origin?: OriginInfo
  key: CacheKey
  decision: 'allow' | 'deny'
  scope: 'session' | 'persistent'
  source: DecisionCacheEntry['source']
}

export interface RecordDecisionMemoryArgs extends Omit<RecordUserAnswerArgs, 'key' | 'scope' | 'decision'> {
  decision: Extract<Decision, { type: 'require-confirm' }>
  key: CacheKey
}

export interface RecordMemoryTierArgs extends Omit<RecordUserAnswerArgs, 'key' | 'scope' | 'decision'> {
  memoryTiers: readonly MemoryTier[]
  key: CacheKey
}

function sameCacheKey(left: CacheKey, right: CacheKey): boolean {
  return canonicalKeyJson(left) === canonicalKeyJson(right)
}

/**
 * 用户确认后的唯一受限写入口：key 必须来自本次 require-confirm Decision 的 memoryTiers。
 * 这样写入侧不会重新推导或接受调用方伪造的缓存范围；无档位的 Decision 永远不能写入。
 */
export function recordUserAnswerFromDecision(args: RecordDecisionMemoryArgs): void {
  recordUserAnswerFromMemoryTiers({ ...args, memoryTiers: args.decision.memoryTiers })
}

/** IM/确认通道适配入口：只允许写入该通道实际展示给用户的 memoryTiers。 */
export function recordUserAnswerFromMemoryTiers(args: RecordMemoryTierArgs): void {
  if (args.memoryTiers.length === 0) {
    throw new Error('MEMORY_WRITE_NOT_ALLOWED')
  }
  const tier = args.memoryTiers.find((candidate) => sameCacheKey(candidate.key, args.key))
  if (!tier) throw new Error('MEMORY_WRITE_KEY_NOT_IN_DECISION')
  recordSystemManagedCacheEntry({
    ...args,
    decision: 'allow',
    scope: scopeForCacheKey(args.key)
  })
}

/**
 * 用户确认回答的缓存写入（桌面卡片记忆档位 / IM 记N 共用，§5.5 recordUserAnswer 等价物）。
 *
 * 经 AuditedDecisionCache 落 `cache.write` 审计事件（与"写缓存在执行链路"同侧，§5.6-4）。
 * approved-with-action / timeout 不产生缓存写入（调用方保证只在 approved/rejected 且有
 * 记忆档位时调用）。
 */
/**
 * 受控系统管理写入口：仅供设置、显式信任操作和历史迁移使用。
 * 普通工具确认必须使用 recordUserAnswerFromDecision/FromMemoryTiers。
 */
export function recordSystemManagedCacheEntry(args: RecordUserAnswerArgs): void {
  const now = Date.now()
  const cache = new AuditedDecisionCache({
    cache: new SqliteDecisionCache(getDbConnection(args.db)),
    audit: args.audit ?? { record: () => undefined },
    sessionId: args.sessionId,
    lane: args.lane,
    ...(args.origin ? { origin: args.origin } : {})
  })
  cache.record({
    id: canonicalKeyJson(args.key),
    key: args.key,
    decision: args.decision,
    lane: args.lane,
    scope: args.scope,
    createdAt: now,
    lastHitAt: now,
    hitCount: 0,
    source: args.source,
    ...(expiresAtForKey(args.key, now) ? { expiresAt: expiresAtForKey(args.key, now)! } : {})
  })
}

/**
 * 仅供用户确认回调使用的受保护写入口。
 * 普通工具代码不应直接获得 permit；消费成功后才允许复用现有 audited writer。
 */
export function recordUserAnswerToCacheWithPermit(
  args: RecordUserAnswerArgs,
  authorization: ConfirmationAuthorizationRegistry,
  permit: MemoryWritePermit,
  subject: MemoryWritePermitSubject
): void {
  authorization.consume(permit, subject)
  recordSystemManagedCacheEntry(args)
}
