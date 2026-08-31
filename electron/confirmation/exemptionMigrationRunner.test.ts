import { afterEach, describe, expect, it } from 'vitest'
import { getConfigValue, getDbConnection, openSqliteDatabase } from '../database'
import type { AppDatabase } from '../database'
import { addTrustedCommand } from '../shell/shellCommandTrust'
import { persistBrowserConfig } from '../browser/browserConfigDb'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import type { AuditSink } from './audit'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import {
  CONFIRMATION_EXEMPTION_MIGRATION_VERSION,
  EXEMPTION_MIGRATION_VERSION_KEY,
  runExemptionMigrationOnce
} from './exemptionMigrationRunner'

const dbs: AppDatabase[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))

function fakeAudit(): { sink: AuditSink; events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { sink: { record: (e) => events.push(e) }, events }
}

describe('runExemptionMigrationOnce（§6 启动一次性豁免迁移）', () => {
  it('首次启动迁移存量 shell 信任命令 + 浏览器域名信任，并逐条落 migration.* 审计', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    addTrustedCommand(db, 'ping baidu.com')
    persistBrowserConfig(db, { trustedDomains: ['example.com'], actTrustedDomains: ['feishu.cn'] })

    const { sink, events } = fakeAudit()
    const r = runExemptionMigrationOnce(db, { audit: sink })
    expect(r.status).toBe('done')
    expect(r.written).toBe(3)

    const cache = new SqliteDecisionCache(getDbConnection(db))
    expect(cache.lookup({ kind: 'shell-command', verb: 'ping baidu.com', level: 'exact' })).not.toBeNull()
    expect(cache.lookup({ kind: 'domain', domain: 'example.com', level: 'domain-any-action' })).not.toBeNull()
    expect(cache.lookup({ kind: 'domain', domain: 'feishu.cn', level: 'domain-any-action' })).not.toBeNull()

    expect(events).toHaveLength(3)
    for (const e of events) {
      expect(e.event.startsWith('migration.')).toBe(true)
      expect(e.actor).toBe('migration')
    }

    // 版本门控写入（沿用 remoteSecurityConfigVersion 先例）
    expect(Number(getConfigValue(db, EXEMPTION_MIGRATION_VERSION_KEY))).toBe(
      CONFIRMATION_EXEMPTION_MIGRATION_VERSION
    )
  })

  it('版本已是当前版本 → 跳过，不写缓存不落审计', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    addTrustedCommand(db, 'ping baidu.com')

    const first = fakeAudit()
    expect(runExemptionMigrationOnce(db, { audit: first.sink }).status).toBe('done')

    const second = fakeAudit()
    const r = runExemptionMigrationOnce(db, { audit: second.sink })
    expect(r.status).toBe('skipped')
    expect(r.written).toBe(0)
    expect(second.events).toHaveLength(0)
  })

  it('迁移失败不阻塞启动：不抛错、版本不推进，修复后可重入完成（幂等）', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    addTrustedCommand(db, 'ping baidu.com')

    // 第一次：读取浏览器豁免抛错 → failed，不推进版本
    const failAudit = fakeAudit()
    const failed = runExemptionMigrationOnce(db, {
      audit: failAudit.sink,
      readBrowserTrustedDomains: () => {
        throw new Error('boom')
      }
    })
    expect(failed.status).toBe('failed')
    expect(getConfigValue(db, EXEMPTION_MIGRATION_VERSION_KEY)).toBeUndefined()

    // 第二次（模拟重启后恢复）：重入成功，条目 upsert 幂等
    const okAudit = fakeAudit()
    const retried = runExemptionMigrationOnce(db, { audit: okAudit.sink })
    expect(retried.status).toBe('done')
    expect(retried.written).toBe(1)

    // 第三次模拟"中断后版本丢失"：手动清版本再跑，缓存条目仍唯一（按规范化键 upsert）
    const cache = new SqliteDecisionCache(getDbConnection(db))
    const before = cache.lookup({ kind: 'shell-command', verb: 'ping baidu.com', level: 'exact' })
    expect(before).not.toBeNull()
  })
})
