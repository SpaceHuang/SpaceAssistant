import { afterEach, describe, expect, it } from 'vitest'
import { getDbConnection, openSqliteDatabase } from '../database'
import type { AppDatabase } from '../database'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import { buildExemptionMigrationEntries, migrateExemptionsToCache } from './exemptionMigration'

const dbs: AppDatabase[] = []
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close())
})

describe('buildExemptionMigrationEntries（P3 豁免迁移）', () => {
  it('shell 信任命令 → shell-command 精确签名键（persistent/migration）', () => {
    const entries = buildExemptionMigrationEntries({ shellTrustedCommands: ['ping baidu.com'] })
    expect(entries).toHaveLength(1)
    const e = entries[0]!
    expect(e.key).toEqual({ kind: 'shell-command', verb: 'ping baidu.com', level: 'exact' })
    expect(e.scope).toBe('persistent')
    expect(e.source).toBe('migration')
    expect(e.decision).toBe('allow')
  })

  it('浏览器持久域名信任（trustedDomains + actTrustedDomains）→ domain 键（去重）', () => {
    const entries = buildExemptionMigrationEntries({
      browserTrustedDomains: ['example.com'],
      actTrustedDomains: ['example.com', 'feishu.cn']
    })
    expect(entries.map((e) => (e.key.kind === 'domain' ? e.key.domain : ''))).toEqual(
      expect.arrayContaining(['example.com', 'feishu.cn'])
    )
    expect(entries).toHaveLength(2)
  })

  it('忽略空命令/域名；并入 extra 条目', () => {
    const entries = buildExemptionMigrationEntries({
      shellTrustedCommands: ['  ', ''],
      extra: [
        {
          id: 'extra-1',
          key: { kind: 'mcp-tool', serverId: 's', toolName: 't' },
          decision: 'allow',
          lane: '*',
          scope: 'session',
          createdAt: 1,
          lastHitAt: 1,
          hitCount: 0,
          source: 'migration'
        }
      ]
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.scope).toBe('session')
  })
})

describe('migrateExemptionsToCache（落库后可 lookup 命中）', () => {
  it('迁移条目写入 SqliteDecisionCache 后可命中', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    const cache = new SqliteDecisionCache(getDbConnection(db))
    const entries = buildExemptionMigrationEntries({ shellTrustedCommands: ['ping baidu.com'] })
    expect(migrateExemptionsToCache(entries, cache)).toBe(1)
    const hit = cache.lookup({ kind: 'shell-command', verb: 'ping baidu.com', level: 'exact' })
    expect(hit).not.toBeNull()
    expect(hit!.decision).toBe('allow')
    expect(hit!.scope).toBe('persistent')
    expect(hit!.source).toBe('migration')
  })
})
