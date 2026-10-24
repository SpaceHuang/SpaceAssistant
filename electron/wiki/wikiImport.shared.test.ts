/**
 * T1.12c：wikiImport 切共享根——ingest 目标 raw/<projectId>/、落盘经挂载沙箱 + wikiWriteMutex、
 * 广播 hint 词汇路径。
 * T1.13：技能用户级安装（getUserSkillsDir）、项目级副本清理函数。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importRawFromWorkDir, wikiImportFileTreeChange } from './wikiImport'
import { computeProjectId } from './wikiProjects'
import { openDatabase } from '../database'
import { installBundledLlmWikiSkill, removeProjectWikiSkillCopy } from './wikiInit'
import { getUserSkillsDir, getProjectSkillsDir } from '../skills/skillPaths'
import { DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'

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

function wikiConfig(): typeof DEFAULT_WIKI_CONFIG {
  return { ...DEFAULT_WIKI_CONFIG, rootPath: 'llm-wiki' }
}
async function initializeReadyWiki(userDataPath: string, config = wikiConfig()): Promise<void> {
  const { createWikiLifecycleController } = await import('./wikiLifecycle')
  const root = path.join(userDataPath, config.rootPath)
  fs.mkdirSync(root, { recursive: true })
  await createWikiLifecycleController(root).initialize({ fresh: true })
}

describe('importRawFromWorkDir 共享根（T1.12c）', () => {
  it('①ingest 目标 raw/<projectId>/<basename>，返回词汇路径', async () => {
    const workDir = tmpdir('wiki-imp-wd-')
    const userData = tmpdir('wiki-imp-ud-')
    fs.writeFileSync(path.join(workDir, 'notes.md'), 'raw content', 'utf8')
    const db = openDatabase(':memory:')
    await initializeReadyWiki(userData)

    const res = await importRawFromWorkDir(workDir, wikiConfig(), 'notes.md', { userDataPath: userData, db })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const projectId = computeProjectId(workDir)
    expect(res.rawRelPath).toBe(`llm-wiki/raw/${projectId}/notes.md`)
    expect(res.copied).toBe(true)
    expect(res.sourceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.sourceRevision).toBe(1)
    const realBase = path.join(userData, 'llm-wiki')
    expect(fs.readFileSync(path.join(realBase, 'raw', projectId, 'notes.md'), 'utf8')).toBe('raw content')
    expect(fs.readFileSync(path.join(realBase, '.wiki-service', 'source-history', res.sourceId!, '1.md'), 'utf8')).toBe('raw content')
    db.close()
  })

  it('文件列表收录后，用返回的词汇 raw 路径启动 Ingest 时从共享根读取', async () => {
    const workDir = tmpdir('wiki-imp-collect-wd-')
    const userData = tmpdir('wiki-imp-collect-ud-')
    fs.writeFileSync(path.join(workDir, 'AGENTS.md'), 'project instructions', 'utf8')
    const db = openDatabase(':memory:')
    const shared = { userDataPath: userData, db } as const
    await initializeReadyWiki(userData)

    const collected = await importRawFromWorkDir(workDir, wikiConfig(), 'AGENTS.md', shared)
    expect(collected).toMatchObject({ ok: true, copied: true, rawRelPath: expect.stringMatching(/^llm-wiki\/raw\//) })
    if (!collected.ok) return

    const ingested = await importRawFromWorkDir(workDir, wikiConfig(), collected.rawRelPath, shared)
    expect(ingested).toMatchObject({ ok: true, copied: false, sourceRevision: 1 })
    db.close()
  })

  it('①b 重名 auto-rename（同项目重复 ingest 同名文件）', async () => {
    const workDir = tmpdir('wiki-imp-ren-')
    const userData = tmpdir('wiki-imp-ren-ud-')
    fs.writeFileSync(path.join(workDir, 'doc.md'), 'v1', 'utf8')
    const db = openDatabase(':memory:')
    const opts = { userDataPath: userData, db } as const
    await initializeReadyWiki(userData)
    const r1 = await importRawFromWorkDir(workDir, wikiConfig(), 'doc.md', opts)
    fs.writeFileSync(path.join(workDir, 'doc.md'), 'v2', 'utf8')
    const r2 = await importRawFromWorkDir(workDir, wikiConfig(), 'doc.md', opts)
    expect(r1.ok && r2.ok).toBe(true)
    if (!(r1.ok && r2.ok)) return
    expect(r2.rawRelPath).not.toBe(r1.rawRelPath)
    expect(r2.rawRelPath).toMatch(/-\d{8}-\d{6}\.md$/)
    db.close()
  })

  it('②ingest 完成广播 hint 为词汇路径（不含真实路径）', async () => {
    const workDir = tmpdir('wiki-imp-hint-')
    const userData = tmpdir('wiki-imp-hint-ud-')
    fs.writeFileSync(path.join(workDir, 'note.md'), 'x', 'utf8')
    const db = openDatabase(':memory:')
    await initializeReadyWiki(userData)
    const res = await importRawFromWorkDir(workDir, wikiConfig(), 'note.md', { userDataPath: userData, db })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const change = wikiImportFileTreeChange(res)
    expect(change).not.toBeNull()
    expect(change!.kind).toBe('paths')
    expect((change as { relPaths: string[] }).relPaths[0]).toMatch(/^llm-wiki\/raw\//)
    expect(JSON.stringify(change)).not.toContain(userData)
    db.close()
  })

  it('③ingest 落盘经互斥区（与并发写同文件串行）', async () => {
    const workDir = tmpdir('wiki-imp-mx-')
    const userData = tmpdir('wiki-imp-mx-ud-')
    fs.writeFileSync(path.join(workDir, 'seq.md'), 'x', 'utf8')
    const db = openDatabase(':memory:')
    await initializeReadyWiki(userData)
    const mutex = await import('./wikiWriteMutex')
    const spy = vi.spyOn(mutex, 'withWikiWriteMutex')
    const res = await importRawFromWorkDir(workDir, wikiConfig(), 'seq.md', { userDataPath: userData, db })
    expect(res.ok).toBe(true)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
    db.close()
  })

  it('复审残余：rootPath 改名（my-lib）时 ingest 返回路径恒为 llm-wiki 词汇前缀', async () => {
    const workDir = tmpdir('wiki-imp-ren2-')
    const userData = tmpdir('wiki-imp-ren2-ud-')
    fs.writeFileSync(path.join(workDir, 'note2.md'), 'x', 'utf8')
    const db = openDatabase(':memory:')
    const cfg = { ...DEFAULT_WIKI_CONFIG, rootPath: 'my-lib' }
    await initializeReadyWiki(userData, cfg)
    const res = await importRawFromWorkDir(workDir, cfg, 'note2.md', { userDataPath: userData, db })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.rawRelPath).toMatch(/^llm-wiki\/raw\//)
    // 物理落盘在配置目录（my-lib）下
    const projectId = computeProjectId(workDir)
    expect(fs.existsSync(path.join(userData, 'my-lib', 'raw', projectId, 'note2.md'))).toBe(true)
    db.close()
  })

  it('拒绝在 recovery_required 下导入，且 raw 与 source binding 均无副作用', async () => {
    const workDir = tmpdir('wiki-imp-recovery-wd-')
    const userData = tmpdir('wiki-imp-recovery-ud-')
    fs.writeFileSync(path.join(workDir, 'blocked.md'), 'must not be imported', 'utf8')
    const wikiRoot = path.join(userData, 'llm-wiki')
    fs.mkdirSync(wikiRoot, { recursive: true })
    const lifecycle = await import('./wikiLifecycle').then(({ createWikiLifecycleController }) => createWikiLifecycleController(wikiRoot))
    await lifecycle.initialize({ fresh: true })
    await lifecycle.markRecoveryRequired()
    const db = openDatabase(':memory:')

    const result = await importRawFromWorkDir(workDir, wikiConfig(), 'blocked.md', { userDataPath: userData, db })

    expect(result).toMatchObject({ ok: false })
    expect(fs.existsSync(path.join(wikiRoot, 'raw'))).toBe(false)
    expect(fs.existsSync(path.join(wikiRoot, '.wiki-service', 'sources'))).toBe(false)
    db.close()
  })
})

describe('技能用户级安装（T1.13）', () => {
  it('init 技能装到用户级目录、workDir .space-skills 无副本；清理函数删除项目级副本', async () => {
    const workDir = tmpdir('wiki-skill-wd-')
    const userData = tmpdir('wiki-skill-ud-')
    const { initWikiStructure } = await import('./wikiInit')
    await initWikiStructure(workDir, wikiConfig(), { userDataPath: userData, installSkill: true })

    const userSkill = path.join(getUserSkillsDir(userData), 'llm-wiki', 'SKILL.md')
    expect(fs.existsSync(userSkill)).toBe(true)
    const projectSkill = path.join(getProjectSkillsDir(workDir)!, 'llm-wiki', 'SKILL.md')
    expect(fs.existsSync(projectSkill)).toBe(false)

    // 迁移清理函数：删除项目级旧副本（R1 覆盖陷阱）
    fs.mkdirSync(path.dirname(projectSkill), { recursive: true })
    fs.writeFileSync(projectSkill, 'old copy', 'utf8')
    const removed = removeProjectWikiSkillCopy(workDir)
    expect(removed).toBe(true)
    expect(fs.existsSync(projectSkill)).toBe(false)
  })

  it('installBundledLlmWikiSkill 直接调用时装用户级', async () => {
    const workDir = tmpdir('wiki-skill-d-wd-')
    const userData = tmpdir('wiki-skill-d-ud-')
    const r = await installBundledLlmWikiSkill(workDir, false, userData)
    expect(r.installed).toBe(true)
    expect(fs.existsSync(path.join(getUserSkillsDir(userData), 'llm-wiki', 'SKILL.md'))).toBe(true)
  })
})
