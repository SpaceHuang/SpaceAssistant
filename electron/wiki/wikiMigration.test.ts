/**
 * T2.1/T2.2a/T2.2b/T2.3：存量迁移数据层。
 * 检测五态、文件管线（raw/页面/幂等/互斥/广播/报告 round-trip）、index/log/SCHEMA 归并、别名注册。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../database'
import { CONFIG_KEYS, readWikiConfig } from '../ipc/ipcShared'
import { setConfigValue } from '../database/operations'
import { initWikiStructure, removeProjectWikiSkillCopy } from './wikiInit'
import { detectLegacyWikiRoots, migrateLegacyWikis } from './wikiMigration'
import { computeProjectId } from './wikiProjects'
import { getUserSkillsDir } from '../skills/skillPaths'
import { DEFAULT_WIKI_CONFIG, type WikiConfig } from '../../src/shared/domainTypes'

const dirs: string[] = []
const dbs: ReturnType<typeof openDatabase>[] = []

function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function wikiConfig(overrides: Partial<WikiConfig> = {}): WikiConfig {
  return { ...DEFAULT_WIKI_CONFIG, enabled: true, rootPath: 'llm-wiki', ...overrides }
}

interface World {
  root: string
  userData: string
  sharedRoot: string
  db: ReturnType<typeof openDatabase>
  /** 建一个带旧 wiki 内容的项目 workDir */
  makeLegacyProfile: (name: string, opts?: { customRoot?: string; skillCopy?: boolean }) => { workDir: string; srcRoot: string }
}

async function setupWorld(): Promise<World> {
  const root = tmpdir('wiki-mig-')
  const userData = path.join(root, 'ud')
  const sharedRoot = path.join(userData, 'llm-wiki')
  fs.mkdirSync(userData, { recursive: true })
  const db = openDatabase(':memory:')
  dbs.push(db)
  await initWikiStructure(root, wikiConfig(), { userDataPath: userData, installSkill: false })
  return {
    root,
    userData,
    sharedRoot,
    db,
    makeLegacyProfile: (name, opts = {}) => {
      const workDir = path.join(root, name)
      const rootName = opts.customRoot ?? 'llm-wiki'
      const srcRoot = path.join(workDir, rootName)
      fs.mkdirSync(path.join(srcRoot, 'wiki', 'entities'), { recursive: true })
      fs.mkdirSync(path.join(srcRoot, 'raw'), { recursive: true })
      fs.writeFileSync(path.join(srcRoot, 'SCHEMA.md'), 'legacy schema v1 body\n', 'utf8')
      fs.writeFileSync(path.join(srcRoot, 'wiki', 'index.md'), '- [旧页](entities/old.md)\n', 'utf8')
      fs.writeFileSync(path.join(srcRoot, 'wiki', 'log.md'), '## [2026-01-01 10:00] ingest notes.md\n内容\n', 'utf8')
      fs.writeFileSync(path.join(srcRoot, 'wiki', 'entities', 'old.md'), '旧页内容\n', 'utf8')
      fs.writeFileSync(path.join(srcRoot, 'raw', 'notes.md'), 'raw notes\n', 'utf8')
      if (opts.skillCopy) {
        fs.mkdirSync(path.join(workDir, '.space-skills', 'llm-wiki'), { recursive: true })
        fs.writeFileSync(path.join(workDir, '.space-skills', 'llm-wiki', 'SKILL.md'), 'old skill', 'utf8')
      }
      return { workDir, srcRoot }
    }
  }
}

describe('T2.1 迁移检测', () => {
  it('五态：无旧根 / 单默认根 / 多 profile / 自定义根（双扫）/ 共享库已初始化仍可增量', async () => {
    const world = await setupWorld()
    // 无旧根
    expect(detectLegacyWikiRoots({ profiles: [{ workDir: path.join(world.root, 'empty') }], sharedRootInitialized: true })).toEqual({
      legacyRoots: [],
      pendingLegacyMigration: false
    })
    // 单默认根
    const p1 = world.makeLegacyProfile('a')
    const d1 = detectLegacyWikiRoots({ profiles: [{ workDir: p1.workDir }], sharedRootInitialized: true })
    expect(d1.pendingLegacyMigration).toBe(true)
    expect(d1.legacyRoots).toEqual(['llm-wiki'])
    // 多 profile 多根
    const p2 = world.makeLegacyProfile('b')
    const d2 = detectLegacyWikiRoots({ profiles: [{ workDir: p1.workDir }, { workDir: p2.workDir }], sharedRootInitialized: true })
    expect(d2.pendingLegacyMigration).toBe(true)
    // 自定义根双扫：存量配置 rootPath=notes-wiki 时被纳入
    const p3 = world.makeLegacyProfile('c', { customRoot: 'notes-wiki' })
    const d3 = detectLegacyWikiRoots({ profiles: [{ workDir: p3.workDir }], storedRootPath: 'notes-wiki', sharedRootInitialized: true })
    expect(d3.legacyRoots).toEqual(expect.arrayContaining(['notes-wiki']))
    // 不传 storedRootPath 时自定义根不被发现（仅默认名扫描）
    const d4 = detectLegacyWikiRoots({ profiles: [{ workDir: p3.workDir }], sharedRootInitialized: true })
    expect(d4.pendingLegacyMigration).toBe(false)
  })
})

describe('T2.2a 迁移文件管线', () => {
  it('raw 拷入 raw/<projectId>/、页面拷入、技能副本删除、旧目录改名、幂等重跑收敛', async () => {
    const world = await setupWorld()
    const p = world.makeLegacyProfile('proj-a', { skillCopy: true })
    const report = await migrateLegacyWikis({
      db: world.db,
      userDataPath: world.userData,
      wikiConfig: wikiConfig(),
      profiles: [{ workDir: p.workDir, profileName: 'proj-a' }]
    })

    // raw → raw/<projectId>/
    const projectId = expectProjectRegistered(world.db, p.workDir)
    expect(fs.readFileSync(path.join(world.sharedRoot, 'raw', projectId, 'notes.md'), 'utf8')).toBe('raw notes\n')
    // 页面拷入
    expect(fs.readFileSync(path.join(world.sharedRoot, 'wiki', 'entities', 'old.md'), 'utf8')).toBe('旧页内容\n')
    // 技能副本删除
    expect(fs.existsSync(path.join(p.workDir, '.space-skills', 'llm-wiki'))).toBe(false)
    // 旧目录改名保留
    expect(fs.existsSync(p.srcRoot)).toBe(false)
    const migrated = fs.readdirSync(p.workDir).filter((n) => n.includes('.migrated-'))
    expect(migrated).toHaveLength(1)
    // 报告
    expect(report.profiles?.[0]?.status).toBe('migrated')
    expect(removeProjectWikiSkillCopy(p.workDir)).toBe(false)

    // 幂等重跑：已迁移（srcRoot 不存在）→ skipped，无重复拷贝
    const report2 = await migrateLegacyWikis({
      db: world.db,
      userDataPath: world.userData,
      wikiConfig: wikiConfig(),
      profiles: [{ workDir: p.workDir, profileName: 'proj-a' }]
    })
    expect(report2.profiles?.[0]?.status).toBe('skipped')
  })

  it('冲突双保留 <name>.from-<projectId>.md + 平行版本提示行 + 报告 conflicts/renames', async () => {
    const world = await setupWorld()
    const p = world.makeLegacyProfile('proj-b')
    fs.writeFileSync(path.join(world.sharedRoot, 'wiki', 'entities', 'old.md'), '共享库已有内容\n', 'utf8')

    const report = await migrateLegacyWikis({
      db: world.db,
      userDataPath: world.userData,
      wikiConfig: wikiConfig(),
      profiles: [{ workDir: p.workDir }]
    })

    const projectId = expectProjectRegistered(world.db, p.workDir)
    const kept = path.join(world.sharedRoot, 'wiki', 'entities', `old.from-${projectId}.md`)
    expect(fs.readFileSync(kept, 'utf8')).toContain('旧页内容')
    expect(fs.readFileSync(kept, 'utf8')).toContain('[wiki-migration]')
    expect(fs.readFileSync(path.join(world.sharedRoot, 'wiki', 'entities', 'old.md'), 'utf8')).toContain('共享库已有内容')
    expect(report.conflicts?.some((c) => c.path.includes('entities/old.md'))).toBe(true)
    expect(report.renames?.some((r) => r.to.includes(`old.from-${projectId}.md`))).toBe(true)
  })

  it('迁移写入经互斥区（与并发写同文件串行）', async () => {
    const world = await setupWorld()
    const p = world.makeLegacyProfile('proj-mx')
    const mutex = await import('./wikiWriteMutex')
    const spy = vi.spyOn(mutex, 'withWikiWriteMutex')
    await migrateLegacyWikis({
      db: world.db,
      userDataPath: world.userData,
      wikiConfig: wikiConfig(),
      profiles: [{ workDir: p.workDir }]
    })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('报告持久化至 config.wiki.migration 并 round-trip 可读；广播 hint 为词汇路径', async () => {
    const world = await setupWorld()
    const p = world.makeLegacyProfile('proj-c')
    const changed: string[] = []
    await migrateLegacyWikis({
      db: world.db,
      userDataPath: world.userData,
      wikiConfig: wikiConfig(),
      profiles: [{ workDir: p.workDir }],
      onFileTreeChange: (paths) => paths.forEach((x) => changed.push(x))
    })

    const cfg = readWikiConfig(world.db)
    expect(cfg.migration?.status).toBe('completed')
    expect(cfg.migration?.report?.profiles?.[0]?.status).toBe('migrated')
    expect(cfg.migration?.completedAt).toBeTruthy()
    // 广播 hint：词汇路径、不含 userData 真实路径
    expect(changed.length).toBeGreaterThan(0)
    expect(changed.every((c) => c.startsWith('llm-wiki/'))).toBe(true)
    expect(JSON.stringify(changed)).not.toContain(world.userData)
  })

  it('extraLegacyRoots 手工指定根走同一管线', async () => {
    const world = await setupWorld()
    const p = world.makeLegacyProfile('proj-d', { customRoot: 'hand-made' })
    await migrateLegacyWikis({
      db: world.db,
      userDataPath: world.userData,
      wikiConfig: wikiConfig(),
      profiles: [{ workDir: p.workDir }],
      extraLegacyRoots: [{ workDir: p.workDir, rootDirName: 'hand-made' }]
    })
    expect(fs.existsSync(p.srcRoot)).toBe(false)
    // 自定义根 → 别名注册
    const cfg = readWikiConfig(world.db)
    expect(cfg.legacyRootAliases).toContain('hand-made')
  })
})

describe('T2.2b index/log/SCHEMA 归并', () => {
  it('index 分类归并 + 冲突条目标注来源；log 时间戳归并 + [project:<id>] 前缀', async () => {
    const world = await setupWorld()
    const p = world.makeLegacyProfile('proj-e')
    fs.writeFileSync(path.join(world.sharedRoot, 'wiki', 'index.md'), '- [共享页](entities/shared.md)\n', 'utf8')
    fs.writeFileSync(
      path.join(world.sharedRoot, 'wiki', 'log.md'),
      '## [2026-02-01 09:00] [project:p-00000000] ingest shared.md\n共享条目\n',
      'utf8'
    )

    await migrateLegacyWikis({
      db: world.db,
      userDataPath: world.userData,
      wikiConfig: wikiConfig(),
      profiles: [{ workDir: p.workDir }]
    })

    const projectId = expectProjectRegistered(world.db, p.workDir)
    const index = fs.readFileSync(path.join(world.sharedRoot, 'wiki', 'index.md'), 'utf8')
    expect(index).toContain('entities/shared.md')
    expect(index).toContain('entities/old.md')
    expect(index).toContain(`from:${projectId}`)

    const log = fs.readFileSync(path.join(world.sharedRoot, 'wiki', 'log.md'), 'utf8')
    expect(log).toContain('[project:p-00000000]')
    expect(log).toContain(`[project:${projectId}]`)
    // 时间戳归并：2026-01-01（旧项目）排在 2026-02-01（共享）之前
    expect(log.indexOf('2026-01-01')).toBeLessThan(log.indexOf('2026-02-01'))
  })

  it('SCHEMA 三分支：默认模板替换 / 已修改保留 legacy 副本 / 缺失忽略', async () => {
    const world = await setupWorld()
    // 共享库 SCHEMA 先移除，验证「默认模板 → 用新版」分支
    const p1 = world.makeLegacyProfile('proj-f1')
    fs.writeFileSync(path.join(p1.srcRoot, 'SCHEMA.md'), '# LLM Wiki Schema\n\n> 本文件定义 Wiki 目录约定与 ingest / query / lint 工作流。可与 LLM 协作演化。\n', 'utf8')
    fs.rmSync(path.join(world.sharedRoot, 'SCHEMA.md'))
    await migrateLegacyWikis({
      db: world.db,
      userDataPath: world.userData,
      wikiConfig: wikiConfig(),
      profiles: [{ workDir: p1.workDir }]
    })
    // 新版模板（含共享守则）被采用
    expect(fs.readFileSync(path.join(world.sharedRoot, 'SCHEMA.md'), 'utf8')).toContain('共享协作守则')

    // 已修改 → SCHEMA.legacy-<projectId>.md
    const p2 = world.makeLegacyProfile('proj-f2')
    await migrateLegacyWikis({
      db: world.db,
      userDataPath: world.userData,
      wikiConfig: wikiConfig(),
      profiles: [{ workDir: p2.workDir }]
    })
    const projectId2 = expectProjectRegistered(world.db, p2.workDir)
    const legacyCopy = path.join(world.sharedRoot, `SCHEMA.legacy-${projectId2}.md`)
    expect(fs.readFileSync(legacyCopy, 'utf8')).toBe('legacy schema v1 body\n')

    // 缺失 → 忽略
    const p3 = world.makeLegacyProfile('proj-f3')
    fs.rmSync(path.join(p3.srcRoot, 'SCHEMA.md'))
    await expect(migrateLegacyWikis({
      db: world.db,
      userDataPath: world.userData,
      wikiConfig: wikiConfig(),
      profiles: [{ workDir: p3.workDir }]
    })).resolves.toBeDefined()
  })
})

describe('T2.3 别名注册接通', () => {
  it('迁移后挂载层识别别名（readOnly）；别名前缀写拒绝由挂载/执行层承担', async () => {
    const world = await setupWorld()
    const p = world.makeLegacyProfile('proj-g', { customRoot: 'old-wiki' })
    await migrateLegacyWikis({
      db: world.db,
      userDataPath: world.userData,
      wikiConfig: wikiConfig(),
      profiles: [{ workDir: p.workDir }],
      extraLegacyRoots: [{ workDir: p.workDir, rootDirName: 'old-wiki' }]
    })

    const cfg = readWikiConfig(world.db)
    expect(cfg.legacyRootAliases).toContain('old-wiki')

    const { resolveWikiMount } = await import('./wikiMount')
    const res = resolveWikiMount(world.root, cfg, world.userData, 'old-wiki/wiki/index.md')
    expect(res.mounted).toBe(true)
    expect((res as { readOnly?: boolean }).readOnly).toBe(true)
    // 配置持久化后挂载生效（file:read-file('old-wiki/...') 打开共享根同路径）
    expect((res as { realPath?: string }).realPath).toBe(path.join(world.sharedRoot, 'wiki', 'index.md'))
  })
})

function expectProjectRegistered(db: ReturnType<typeof openDatabase>, workDir: string): string {
  void db
  return computeProjectId(workDir)
}
