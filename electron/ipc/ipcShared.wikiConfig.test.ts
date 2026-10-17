import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../database'
import { setConfigValue } from '../database/operations'
import { CONFIG_KEYS, readWikiConfig } from './ipcShared'
import { DEFAULT_WIKI_CONFIG, mergeWikiConfig } from '../../src/shared/domainTypes'

const dirs: string[] = []
const dbs: AppDatabase[] = []

function createDb(): AppDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-config-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'test.db'))
  dbs.push(db)
  return db
}

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close()
    } catch {
      // ignore
    }
  }
  dbs.length = 0
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  dirs.length = 0
})

describe('readWikiConfig 新字段默认值（T0.2）', () => {
  it('空库返回带默认值的完整 WikiConfig（含 legacyRootAliases 与 migration）', () => {
    const db = createDb()
    const config = readWikiConfig(db)

    expect(config.rootPath).toBe('llm-wiki')
    expect(config.hideWikiFromFileTree).toBe(true)
    expect(config.interactiveIngest).toBe(false)
    expect(config.maxBatchIngest).toBe(10)
    expect(config.legacyRootAliases).toEqual([])
    expect(config.migration).toBeDefined()
    expect(config.migration?.status).toBe('idle')
    expect(config).toEqual(DEFAULT_WIKI_CONFIG)
  })

  it('旧版配置（无新字段）读取后补齐新字段默认值', () => {
    const db = createDb()
    setConfigValue(
      db,
      CONFIG_KEYS.wiki,
      JSON.stringify({ rootPath: 'my-lib', hideWikiFromFileTree: false, interactiveIngest: true, maxBatchIngest: 5 })
    )

    const config = readWikiConfig(db)

    expect(config.rootPath).toBe('my-lib')
    expect(config.legacyRootAliases).toEqual([])
    expect(config.migration?.status).toBe('idle')
  })

  it('含 legacyRootAliases 与 migration 的配置 round-trip 读回一致', () => {
    const db = createDb()
    const stored = {
      rootPath: 'llm-wiki',
      hideWikiFromFileTree: true,
      interactiveIngest: false,
      maxBatchIngest: 10,
      legacyRootAliases: ['old-wiki', 'notes-root'],
      migration: {
        status: 'completed',
        completedAt: '2026-10-10T08:00:00.000Z',
        report: { profiles: [{ workDir: 'E:/a', rootDirName: 'old-wiki', status: 'migrated' }], renames: [{ from: 'old-wiki/index.md', to: 'llm-wiki/index.md' }] },
        legacyRootAliases: ['old-wiki']
      }
    }
    setConfigValue(db, CONFIG_KEYS.wiki, JSON.stringify(stored))

    const config = readWikiConfig(db)

    expect(config.legacyRootAliases).toEqual(['old-wiki', 'notes-root'])
    expect(config.migration?.status).toBe('completed')
    expect(config.migration?.completedAt).toBe('2026-10-10T08:00:00.000Z')
    expect(config.migration?.legacyRootAliases).toEqual(['old-wiki'])
    expect(config.migration?.report?.renames?.[0]?.to).toBe('llm-wiki/index.md')
  })

  it('非法值（非数组的 legacyRootAliases / 非对象 migration）被归一为默认', () => {
    const db = createDb()
    setConfigValue(
      db,
      CONFIG_KEYS.wiki,
      JSON.stringify({ legacyRootAliases: 'old-wiki', migration: 'nope' })
    )

    const config = readWikiConfig(db)

    expect(config.legacyRootAliases).toEqual([])
    expect(config.migration?.status).toBe('idle')
  })

  it('migration 非法 status 被归一为 idle', () => {
    const db = createDb()
    setConfigValue(db, CONFIG_KEYS.wiki, JSON.stringify({ migration: { status: 'bogus' } }))

    const config = readWikiConfig(db)

    expect(config.migration?.status).toBe('idle')
  })
})

describe('configIpc wiki set 链透传（T1.18）', () => {
  it('set 链（mergeWikiConfig({...cur, ...payload})）保留 legacyRootAliases/migration，非法值归一', () => {
    // 模拟 configIpc 的写侧组合逻辑（configIpc.ts wiki 分支）
    const cur = mergeWikiConfig({ legacyRootAliases: ['old-wiki'] })
    const payload = { maxBatchIngest: 20, legacyRootAliases: ['old-wiki', 'notes-root'] }
    const next = mergeWikiConfig({ ...cur, ...payload })
    expect(next.legacyRootAliases).toEqual(['old-wiki', 'notes-root'])
    expect(next.maxBatchIngest).toBe(20)

    // payload 未提供别名字段时 spread 不清空既有值
    const keep = mergeWikiConfig({ ...cur })
    expect(keep.legacyRootAliases).toEqual(['old-wiki'])

    // 非法值被归一
    const bad = mergeWikiConfig({ ...cur, ...{ legacyRootAliases: 'nope' } })
    expect(bad.legacyRootAliases).toEqual([])
  })
})
