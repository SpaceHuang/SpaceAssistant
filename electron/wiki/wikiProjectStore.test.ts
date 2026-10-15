import { describe, expect, it } from 'vitest'
import { openDatabase } from '../database'
import type { AppDatabase } from '../database/sqliteStore'
import {
  getWikiProjectByWorkDir,
  insertWikiProject,
  listWikiProjects,
  markWikiProjectOrphan
} from './wikiProjectStore'

function createDb(): AppDatabase {
  return openDatabase(':memory:')
}

describe('wikiProjectStore CRUD（T0.3）', () => {
  it('insert 后 getByWorkDir/list 读回完整行', () => {
    const db = createDb()

    insertWikiProject(db, { projectId: 'p-12345678', workDir: 'E:\\Develop\\demo', displayName: 'demo' })

    const row = getWikiProjectByWorkDir(db, 'E:\\Develop\\demo')
    expect(row).toBeDefined()
    expect(row?.projectId).toBe('p-12345678')
    expect(row?.displayName).toBe('demo')
    expect(row?.orphan).toBe(false)
    expect(row?.firstSeenAt).toBeGreaterThan(0)

    expect(listWikiProjects(db)).toHaveLength(1)
    db.close()
  })

  it('同 workDir 重复 insert 收敛为同一行（UNIQUE 冲突不抛错，更新展示元数据）', () => {
    const db = createDb()

    insertWikiProject(db, { projectId: 'p-12345678', workDir: 'E:\\Develop\\demo', displayName: 'demo', profileId: 'profile-a' })
    expect(() =>
      insertWikiProject(db, { projectId: 'p-12345678', workDir: 'E:\\Develop\\demo', displayName: 'demo-renamed', profileId: 'profile-b' })
    ).not.toThrow()

    const rows = listWikiProjects(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].projectId).toBe('p-12345678')
    expect(rows[0].displayName).toBe('demo-renamed')
    expect(rows[0].profileId).toBe('profile-b')
    // firstSeenAt 保留首次登记时间
    expect(rows[0].firstSeenAt).toBeGreaterThan(0)
    db.close()
  })

  it('markOrphan 置位与清除', () => {
    const db = createDb()
    insertWikiProject(db, { projectId: 'p-aaaaaaaa', workDir: 'C:\\work\\gone', displayName: 'gone' })

    markWikiProjectOrphan(db, 'p-aaaaaaaa', true)
    let row = listWikiProjects(db).find((r) => r.projectId === 'p-aaaaaaaa')
    expect(row?.orphan).toBe(true)

    markWikiProjectOrphan(db, 'p-aaaaaaaa', false)
    row = listWikiProjects(db).find((r) => r.projectId === 'p-aaaaaaaa')
    expect(row?.orphan).toBe(false)
    db.close()
  })

  it('不存在的 workDir / projectId 返回 undefined / 无副作用', () => {
    const db = createDb()
    expect(getWikiProjectByWorkDir(db, 'E:\\nope')).toBeUndefined()
    expect(() => markWikiProjectOrphan(db, 'p-00000000', true)).not.toThrow()
    expect(listWikiProjects(db)).toEqual([])
    db.close()
  })
})
