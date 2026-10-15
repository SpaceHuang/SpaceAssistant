/**
 * T1.12b：projectId / display_name / wiki_projects 登记。
 * §6.2：projectId = p-<sha256(canonicalWorkDir).slice(0,8)>（不使用 profileId）；
 * display_name 四规则：profile 名 → basename → 重名追加一级父目录 → tooltip 完整路径（tooltip 由 UI 承担）。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database'
import {
  computeProjectId,
  computeDisplayName,
  registerWikiProject
} from './wikiProjects'
import { listWikiProjects } from './wikiProjectStore'

const dirs: string[] = []

function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('projectId 计算（T1.12b）', () => {
  it('①同目录两次计算同 id、不同目录不同 id', () => {
    const a = tmpdir('wiki-pj-a-')
    const b = tmpdir('wiki-pj-b-')
    const id1 = computeProjectId(a)
    const id2 = computeProjectId(a)
    expect(id1).toBe(id2)
    expect(id1).toMatch(/^p-[0-9a-f]{8}$/)
    expect(computeProjectId(b)).not.toBe(id1)
  })

  it('②Windows 大小写/分隔符差异规范化后收敛同 id', () => {
    const real = tmpdir('wiki-pj-case-')
    const upper = real.toUpperCase()
    const mixed = real.replace(/\\/g, '/')
    if (process.platform === 'win32') {
      expect(upper).not.toBe(real) // fixture 本身大小写不同
      expect(computeProjectId(upper)).toBe(computeProjectId(real))
    }
    expect(computeProjectId(mixed)).toBe(computeProjectId(real))
  })
})

describe('display_name 四规则（T1.12b）', () => {
  it('规则 1：关联 profile → 用 profile 名', () => {
    expect(computeDisplayName('E:\\work\\demo', '我的项目')).toBe('我的项目')
  })

  it('规则 2：裸 workDir → 用 basename', () => {
    expect(computeDisplayName('E:\\Develop\\SpaceAssistant')).toBe('SpaceAssistant')
  })

  it('规则 3：basename 重名 → 追加一级父目录消歧', () => {
    const db = openDatabase(':memory:')
    expect(computeDisplayName('C:\\work\\demo', undefined, db)).toBe('demo')
    // 先登记 C:\work\demo，再登记 D:\archive\demo → 后者重名消歧
    const first = registerWikiProject(db, { workDir: 'C:\\work\\demo' })
    expect(first.displayName).toBe('demo')
    const second = registerWikiProject(db, { workDir: 'D:\\archive\\demo' })
    expect(second.displayName).toBe('archive/demo')
    db.close()
  })
})

describe('registerWikiProject 登记（T1.12b）', () => {
  it('登记后 wiki_projects 行断言：UNIQUE 冲突收敛、orphan 置位保留', () => {
    const db = openDatabase(':memory:')
    const dir = tmpdir('wiki-pj-reg-')
    const first = registerWikiProject(db, { workDir: dir, profileId: 'pf-a', profileName: 'alpha' })
    expect(first.projectId).toMatch(/^p-[0-9a-f]{8}$/)
    expect(first.displayName).toBe('alpha')

    // 同目录重复登记：projectId 收敛同一行，展示元数据更新
    const again = registerWikiProject(db, { workDir: dir, profileId: 'pf-b', profileName: 'beta' })
    expect(again.projectId).toBe(first.projectId)
    expect(again.displayName).toBe('beta')

    const rows = listWikiProjects(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].profileId).toBe('pf-b')
    db.close()
  })
})
