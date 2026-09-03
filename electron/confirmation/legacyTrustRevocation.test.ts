import { afterEach, describe, expect, it } from 'vitest'
import { openSqliteDatabase, type AppDatabase } from '../database'
import { addTrustedCommand, listTrustedCommands } from '../shell/shellCommandTrust'
import { persistBrowserConfig, readBrowserConfigFromDb } from '../browser/browserConfigDb'
import {
  revokeAllLegacyTrust,
  revokeLegacyTrustForCacheKey
} from './legacyTrustRevocation'
import type { CacheKey } from '../../src/shared/confirmation/types'

const shells: AppDatabase[] = []

function open(): AppDatabase {
  const db = openSqliteDatabase(':memory:')
  shells.push(db)
  return db
}

afterEach(() => {
  shells.splice(0).forEach((db) => db.close())
})

describe('revokeLegacyTrustForCacheKey（B6/B7：清除确认记忆联动撤销旧信任存储）', () => {
  it('shell-command exact 键撤销匹配的旧库信任条目', () => {
    const db = open()
    const added = addTrustedCommand(db, 'git status')!
    expect(added).not.toBeNull()
    const key: CacheKey = { kind: 'shell-command', verb: 'git status', level: 'exact' }
    const r = revokeLegacyTrustForCacheKey(db, key)
    expect(r.shellRemoved).toBe(1)
    expect(listTrustedCommands(db)).toHaveLength(0)
  })

  it('shell-command 键不匹配时不动旧库', () => {
    const db = open()
    addTrustedCommand(db, 'git status')
    const r = revokeLegacyTrustForCacheKey(db, { kind: 'shell-command', verb: 'npm test', level: 'exact' })
    expect(r.shellRemoved).toBe(0)
    expect(listTrustedCommands(db)).toHaveLength(1)
  })

  it('domain-any-action 键撤销 browser.trustedDomains', () => {
    const db = open()
    persistBrowserConfig(db, { trustedDomains: ['example.com'], actTrustedDomains: ['act.com'] })
    const r = revokeLegacyTrustForCacheKey(db, { kind: 'domain', domain: 'example.com', level: 'domain-any-action' })
    expect(r.trustedDomainsRemoved).toBe(1)
    const cfg = readBrowserConfigFromDb(db)
    expect(cfg.trustedDomains).toEqual([])
    expect(cfg.actTrustedDomains).toEqual(['act.com'])
  })

  it('domain+action 键撤销 browser.actTrustedDomains', () => {
    const db = open()
    persistBrowserConfig(db, { trustedDomains: ['example.com'], actTrustedDomains: ['act.com'] })
    const r = revokeLegacyTrustForCacheKey(db, { kind: 'domain', domain: 'act.com', level: 'domain+action' })
    expect(r.actTrustedDomainsRemoved).toBe(1)
    const cfg = readBrowserConfigFromDb(db)
    expect(cfg.actTrustedDomains).toEqual([])
    expect(cfg.trustedDomains).toEqual(['example.com'])
  })

  it('会话级域名键不撤销持久配置信任', () => {
    const db = open()
    persistBrowserConfig(db, { trustedDomains: ['example.com'] })
    const r = revokeLegacyTrustForCacheKey(db, {
      kind: 'domain',
      domain: 'example.com',
      level: 'domain-any-action',
      sessionId: 's1'
    })
    expect(r.trustedDomainsRemoved).toBe(0)
    expect(readBrowserConfigFromDb(db).trustedDomains).toEqual(['example.com'])
  })

  it('其他键类型为 no-op', () => {
    const db = open()
    const r = revokeLegacyTrustForCacheKey(db, { kind: 'remote-write', sessionId: 's1' })
    expect(r).toEqual({ shellRemoved: 0, trustedDomainsRemoved: 0, actTrustedDomainsRemoved: 0 })
  })
})

describe('revokeAllLegacyTrust（清空确认记忆联动）', () => {
  it('清空 shell 信任命令与两张浏览器域名清单', () => {
    const db = open()
    addTrustedCommand(db, 'git status')
    addTrustedCommand(db, 'npm test')
    persistBrowserConfig(db, { trustedDomains: ['a.com'], actTrustedDomains: ['b.com'] })
    const r = revokeAllLegacyTrust(db)
    expect(r.shellRemoved).toBe(2)
    expect(r.trustedDomainsRemoved).toBe(1)
    expect(r.actTrustedDomainsRemoved).toBe(1)
    expect(listTrustedCommands(db)).toHaveLength(0)
    const cfg = readBrowserConfigFromDb(db)
    expect(cfg.trustedDomains).toEqual([])
    expect(cfg.actTrustedDomains).toEqual([])
  })
})
