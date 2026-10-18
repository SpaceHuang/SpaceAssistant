/**
 * T1.12a：wikiInit/wikiStatus 切共享根。
 * ①init 骨架建 {userData}/<rootPath>（meta v2 storage:'shared'）②幂等 ③payload 无 rootPath 自定义入口
 * ④受控 rename（失败回滚 + 广播钩子）⑤wikiStatus 新字段（projects 映射自 wiki_projects 表）
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initWikiStructure, isWikiInitialized, renameWikiRoot } from './wikiInit'
import { getWikiStatus } from './wikiStatus'
import { createWikiLifecycleController } from './wikiLifecycle'
import { openDatabase } from '../database'
import { insertWikiProject, markWikiProjectOrphan } from './wikiProjectStore'
import { DEFAULT_WIKI_CONFIG, type WikiConfig } from '../../src/shared/domainTypes'

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

function wikiConfig(rootPath = 'llm-wiki'): WikiConfig {
  return { ...DEFAULT_WIKI_CONFIG, rootPath }
}

describe('initWikiStructure 共享根（T1.12a）', () => {
  it('①骨架建到 {userData}/<rootPath>，meta v2 storage:shared，子目录全集', async () => {
    const userData = tmpdir('wiki-init-ud-')
    const workDir = tmpdir('wiki-init-wd-')

    const res = await initWikiStructure(workDir, wikiConfig(), { userDataPath: userData })
    expect(res.ok).toBe(true)

    const root = path.join(userData, 'llm-wiki')
    expect(fs.existsSync(path.join(root, 'SCHEMA.md'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'wiki', 'index.md'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'wiki', 'log.md'))).toBe(true)
    for (const sub of ['raw', 'wiki/entities', 'wiki/concepts', 'wiki/topics', 'wiki/sources', 'wiki/queries', 'wiki/projects']) {
      expect(fs.existsSync(path.join(root, sub)), sub).toBe(true)
    }
    const meta = JSON.parse(fs.readFileSync(path.join(root, '.wiki-meta.json'), 'utf8'))
    expect(meta.schemaVersion).toBe(2)
    expect(meta.storage).toBe('shared')
    expect(await createWikiLifecycleController(root).read()).toMatchObject({ lifecycle: 'domain_ready', initialization: 'empty' })
    // workDir 侧不建骨架
    expect(fs.existsSync(path.join(workDir, 'llm-wiki'))).toBe(false)
  })

  it('②重复 init 幂等（不覆盖既有内容）', async () => {
    const userData = tmpdir('wiki-init-idem-')
    const workDir = tmpdir('wiki-init-idem-wd-')
    await initWikiStructure(workDir, wikiConfig(), { userDataPath: userData })
    const indexPath = path.join(userData, 'llm-wiki', 'wiki', 'index.md')
    fs.writeFileSync(indexPath, '# customized', 'utf8')

    const res = await initWikiStructure(workDir, wikiConfig(), { userDataPath: userData })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(indexPath, 'utf8')).toBe('# customized')
  })

  it('③物理目录名读配置：rootPath=my-lib 时骨架建 {userData}/my-lib', async () => {
    const userData = tmpdir('wiki-init-cfg-')
    const workDir = tmpdir('wiki-init-cfg-wd-')
    const res = await initWikiStructure(workDir, wikiConfig('my-lib'), { userDataPath: userData })
    expect(res.ok).toBe(true)
    expect(fs.existsSync(path.join(userData, 'my-lib', 'SCHEMA.md'))).toBe(true)
  })

  it('isWikiInitialized 读共享根', async () => {
    const userData = tmpdir('wiki-init-init-')
    const workDir = tmpdir('wiki-init-init-wd-')
    expect(isWikiInitialized(workDir, wikiConfig(), userData)).toBe(false)
    await initWikiStructure(workDir, wikiConfig(), { userDataPath: userData })
    expect(isWikiInitialized(workDir, wikiConfig(), userData)).toBe(true)
  })

  it('存量部分 Wiki 初始化后进入 preflight 状态，不当作空库', async () => {
    const userData = tmpdir('wiki-init-legacy-')
    const workDir = tmpdir('wiki-init-legacy-wd-')
    const root = path.join(userData, 'llm-wiki')
    fs.mkdirSync(path.join(root, 'raw', 'legacy'), { recursive: true })
    fs.writeFileSync(path.join(root, 'raw', 'legacy', 'note.md'), 'legacy content', 'utf8')
    await initWikiStructure(workDir, wikiConfig(), { userDataPath: userData })
    expect(await createWikiLifecycleController(root).read()).toMatchObject({ lifecycle: 'initializing', initialization: 'existing-content' })
  })
})

describe('renameWikiRoot 受控改名（T1.12a③）', () => {
  it('改名成功：目录迁移 + 配置更新 + 广播钩子触发', async () => {
    const userData = tmpdir('wiki-ren-ud-')
    const workDir = tmpdir('wiki-ren-wd-')
    const db = openDatabase(':memory:')
    await initWikiStructure(workDir, wikiConfig(), { userDataPath: userData })
    fs.writeFileSync(path.join(userData, 'llm-wiki', 'wiki', 'index.md'), '# kept', 'utf8')
    const broadcast = vi.fn()

    const res = renameWikiRoot({ userDataPath: userData, currentRootPath: 'llm-wiki', newRootPath: 'my-lib', broadcast })
    expect(res.ok).toBe(true)
    expect(fs.existsSync(path.join(userData, 'my-lib', 'wiki', 'index.md'))).toBe(true)
    expect(fs.readFileSync(path.join(userData, 'my-lib', 'wiki', 'index.md'), 'utf8')).toBe('# kept')
    expect(fs.existsSync(path.join(userData, 'llm-wiki'))).toBe(false)
    expect(broadcast).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('目标目录已存在 → 失败回滚（配置不动、原目录保留）', async () => {
    const userData = tmpdir('wiki-ren-roll-')
    const workDir = tmpdir('wiki-ren-roll-wd-')
    await initWikiStructure(workDir, wikiConfig(), { userDataPath: userData })
    fs.mkdirSync(path.join(userData, 'my-lib'), { recursive: true })
    const broadcast = vi.fn()

    const res = renameWikiRoot({ userDataPath: userData, currentRootPath: 'llm-wiki', newRootPath: 'my-lib', broadcast })
    expect(res.ok).toBe(false)
    expect(fs.existsSync(path.join(userData, 'llm-wiki', 'SCHEMA.md'))).toBe(true)
    expect(broadcast).not.toHaveBeenCalled()
  })
})

describe('getWikiStatus 新字段（T1.12a④）', () => {
  it('projects/projectCount 映射自 wiki_projects 表；shared: true', async () => {
    const userData = tmpdir('wiki-st-ud-')
    const workDir = tmpdir('wiki-st-wd-')
    const db = openDatabase(':memory:')
    insertWikiProject(db, { projectId: 'p-12345678', workDir: 'E:\\proj-a', displayName: 'proj-a' })
    insertWikiProject(db, { projectId: 'p-9abcdef0', workDir: 'E:\\proj-b', displayName: 'proj-b', profileId: 'pf-1' })
    markWikiProjectOrphan(db, 'p-9abcdef0', true)

    const status = getWikiStatus(workDir, wikiConfig(), { userDataPath: userData, db })
    expect(status.shared).toBe(true)
    expect(status.projectCount).toBe(2)
    expect(status.projects).toEqual([
      { projectId: 'p-12345678', displayName: 'proj-a', workDir: 'E:\\proj-a', orphan: false },
      { projectId: 'p-9abcdef0', displayName: 'proj-b', workDir: 'E:\\proj-b', orphan: true }
    ])
    db.close()
  })
})

describe('模板内容（T1.13③）', () => {
  it('SKILL/SCHEMA 模板含共享守则与禁 shell 关键句', async () => {
    const t = await import('./wikiTemplates')
    expect(t.BUNDLED_LLM_WIKI_SKILL_MD).toContain('跨项目共享记忆库')
    expect(t.BUNDLED_LLM_WIKI_SKILL_MD).toContain('不要用 shell')
    expect(t.BUNDLED_LLM_WIKI_SKILL_MD).toContain('[project:<id>]')
    expect(t.DEFAULT_SCHEMA_MD).toContain('raw/<projectId>/')
    expect(t.DEFAULT_SCHEMA_MD).toContain('wiki/projects/<projectId>/')
    expect(t.DEFAULT_SCHEMA_MD).toContain('不要用 shell')
  })
})
