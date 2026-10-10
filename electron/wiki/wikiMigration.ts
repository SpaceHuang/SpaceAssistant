import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import type { AppDatabase } from '../database/sqliteStore'
import type { WikiConfig, WikiMigrationReport } from '../../src/shared/domainTypes'
import { getConfigValue, setConfigValue } from '../database/operations'
import { CONFIG_KEYS } from '../ipc/ipcShared'
import { DEFAULT_WIKI_ROOT_DIRNAME, WIKI_VOCABULARY_PREFIX } from '../../src/shared/wikiConstants'
import { computeProjectId, registerWikiProject } from './wikiProjects'
import { removeProjectWikiSkillCopy } from './wikiInit'
import { withWikiWriteMutex } from './wikiWriteMutex'
import { DEFAULT_SCHEMA_MD } from './wikiTemplates'

/**
 * 存量迁移（wiki-shared-centralized-storage §12）：检测（含自定义根）→ 幂等合并 → 别名注册。
 * 语义是「幂等可重试」，不是事务（§12.2/I7）：按目标存在性跳过，失败重跑收敛。
 */

/** v1（ed3dac54）默认 SCHEMA 模板全文（BLK-2：哈希分叉判定基准，评审实证 882 字符）。
 *  兼容 LF/CRLF 双哈希（git checkout 平台换行差异）。
 */
export const LEGACY_DEFAULT_SCHEMA_MD_V1 = `# LLM Wiki Schema

> 本文件定义 Wiki 目录约定与 ingest / query / lint 工作流。可与 LLM 协作演化。

## 目录说明

- \`raw/\`：只读原始资料（用户写入；LLM **仅 read**）
- \`wiki/\`：LLM 维护的结构化 Markdown 页面（read/write）
- \`SCHEMA.md\`：本规范文件

## 页面类型

| 类型 | 目录 | 说明 |
|------|------|------|
| entity | wiki/entities/ | 人物、组织、产品等实体 |
| concept | wiki/concepts/ | 概念与术语 |
| topic | wiki/topics/ | 主题综合 / 综述 |
| source | wiki/sources/ | 与 raw 对应的摘要页 |
| query | wiki/queries/ | 由 Query 归档的分析页 |

## Ingest 工作流

1. \`read_file\` 读取 raw 文件
2. 分析要点，更新/创建 wiki 下相关页面（entity、concept、topic、source 等）
3. 更新 \`wiki/index.md\`
4. 向 \`wiki/log.md\` 追加 ingest 条目

**禁止：** 不得修改 \`raw/\`；不得删除 log 历史。

## Query 工作流

1. \`read_file(wiki/index.md)\` — 按分类定位候选页
2. \`read_file\` 深入阅读相关页
3. index 未覆盖时 \`grep(pattern, path=wiki/)\` 补充搜索
4. 综合回答，正文引用 \`wiki/...\` 路径
5. 用户要求时归档为 \`wiki/queries/\` 新页

## Lint 工作流

检查：矛盾声明、过时结论、孤儿页、缺页、缺链、index 与文件系统不一致。

## 输出语言

默认 zh-CN。
`

export interface LegacyRootCandidate {
  workDir: string
  rootDirName: string
}

export interface WikiMigrationDetection {
  /** 检测到的存量根目录名（含自定义根，§12.1） */
  legacyRoots: string[]
  /** 存在任一未迁移旧根 → true（共享库未初始化或已初始化均可增量，§12.1） */
  pendingLegacyMigration: boolean
}

/** 旧结构特征：存在 SCHEMA.md 或 wiki/index.md（§12.1）。 */
export function looksLikeLegacyWikiRoot(absRoot: string): boolean {
  return fs.existsSync(path.join(absRoot, 'SCHEMA.md')) || fs.existsSync(path.join(absRoot, 'wiki', 'index.md'))
}

export function detectLegacyWikiRoots(input: {
  profiles: Array<{ workDir: string }>
  /** 升级前 DB 中的历史 rootPath（≠默认时双扫；S3 边界：仅最近一次值） */
  storedRootPath?: string
  sharedRootInitialized: boolean
}): WikiMigrationDetection {
  const roots = new Set<string>()
  const candidates: LegacyRootCandidate[] = []
  const defaultRoot = DEFAULT_WIKI_ROOT_DIRNAME
  const extra = input.storedRootPath && input.storedRootPath !== defaultRoot ? [input.storedRootPath] : []
  const scanNames = [defaultRoot, ...extra]
  for (const profile of input.profiles) {
    for (const name of scanNames) {
      const abs = path.join(profile.workDir, name)
      if (fs.existsSync(abs) && looksLikeLegacyWikiRoot(abs)) {
        roots.add(name)
        candidates.push({ workDir: profile.workDir, rootDirName: name })
      }
    }
  }
  return {
    legacyRoots: [...roots],
    pendingLegacyMigration: candidates.length > 0
  }
}

// ===== 迁移执行管线（§12.2） =====

export interface WikiMigrationProfileInput {
  workDir: string
  profileId?: string
  profileName?: string
}

export interface MigrateLegacyWikisOptions {
  db: AppDatabase
  userDataPath: string
  wikiConfig: WikiConfig
  profiles: WikiMigrationProfileInput[]
  /** S3 手工指定额外旧根（走同一管线并同样注册别名） */
  extraLegacyRoots?: Array<{ workDir: string; rootDirName: string }>
  onFileTreeChange?: (vocabularyPaths: string[]) => void
  now?: () => Date
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

const PARALLEL_VERSION_NOTE = `> [wiki-migration] 本页存在来自其他项目的平行版本（冲突双保留），请人工核对合并。\n`

async function copyFileLocked(srcAbs: string, destAbs: string): Promise<void> {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true })
  await withWikiWriteMutex(destAbs, async () => {
    fs.copyFileSync(srcAbs, destAbs)
  })
}

/** 页面合并（§12.2 wiki/** 行）：无冲突拷入 / 同内容跳过 / 冲突双保留 + 平行版本提示行。 */
async function mergeWikiPages(
  srcWikiDir: string,
  sharedWikiDir: string,
  projectId: string,
  report: WikiMigrationReport,
  vocabularyRoot: string,
  onFileTreeChange?: (paths: string[]) => void,
  relPrefix = ''
): Promise<void> {
  if (!fs.existsSync(srcWikiDir)) return
  const entries = fs.readdirSync(srcWikiDir, { withFileTypes: true })
  for (const ent of entries) {
    const srcAbs = path.join(srcWikiDir, ent.name)
    const relFromWiki = relPrefix ? `${relPrefix}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      await mergeWikiPages(srcAbs, path.join(sharedWikiDir, ent.name), projectId, report, vocabularyRoot, onFileTreeChange, relFromWiki)
      continue
    }
    if (!ent.isFile() || ent.name === 'index.md' || ent.name === 'log.md') continue
    const destAbs = path.join(sharedWikiDir, ent.name)
    const srcContent = fs.readFileSync(srcAbs, 'utf8')
    if (!fs.existsSync(destAbs)) {
      await copyFileLocked(srcAbs, destAbs)
      report.mergedPageCount = (report.mergedPageCount ?? 0) + 1
      onFileTreeChange?.([`${vocabularyRoot}/wiki/${relFromWiki.replace(/\\/g, '/')}`])
      continue
    }
    const destContent = fs.readFileSync(destAbs, 'utf8')
    if (destContent === srcContent) {
      report.skippedPageCount = (report.skippedPageCount ?? 0) + 1
      continue
    }
    // 冲突双保留：后合并方存 <name>.from-<projectId>.md，两页头部互加提示行
    const dot = ent.name.lastIndexOf('.')
    const stem = dot > 0 ? ent.name.slice(0, dot) : ent.name
    const ext = dot > 0 ? ent.name.slice(dot) : '.md'
    const parallelName = `${stem}.from-${projectId}${ext}`
    const parallelAbs = path.join(sharedWikiDir, parallelName)
    await copyFileLocked(srcAbs, parallelAbs)
    // 提示行（幂等：已含标注则不重复加）
    const annotate = async (abs: string, note: string): Promise<void> => {
      const content = fs.readFileSync(abs, 'utf8')
      if (content.includes('[wiki-migration]')) return
      await withWikiWriteMutex(abs, async () => {
        fs.writeFileSync(abs, note + content, 'utf8')
      })
    }
    await annotate(parallelAbs, PARALLEL_VERSION_NOTE)
    await annotate(destAbs, PARALLEL_VERSION_NOTE)
    const conflictVocab = `${vocabularyRoot}/wiki/${relFromWiki.replace(/\\/g, '/')}`
    report.conflictCount = (report.conflictCount ?? 0) + 1
    report.conflicts = [...(report.conflicts ?? []), { path: conflictVocab, keptAs: parallelName.replace(/\\/g, '/'), sourceProjectId: projectId }]
    report.renames = [...(report.renames ?? []), { from: conflictVocab, to: `${vocabularyRoot}/wiki/${parallelName.replace(/\\/g, '/')}` }]
    onFileTreeChange?.([`${vocabularyRoot}/wiki/${parallelName.replace(/\\/g, '/')}`])
  }
}

/** index.md 归并（§12.2）：不直接覆盖——按行去重追加合并，冲突条目并列标注来源。 */
function mergeIndexFiles(srcIndex: string, sharedIndex: string, projectId: string): void {
  const shared = fs.existsSync(sharedIndex) ? fs.readFileSync(sharedIndex, 'utf8') : ''
  const src = fs.readFileSync(srcIndex, 'utf8')
  const sharedLines = new Set(shared.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
  const additions = src.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !sharedLines.has(l))
  if (additions.length === 0) return
  const annotated = additions.map((l) => `${l} <!-- from:${projectId} -->`)
  const merged = `${shared.replace(/\s*$/, '')}\n\n<!-- merged from ${projectId} -->\n${annotated.join('\n')}\n`
  fs.writeFileSync(sharedIndex, merged, 'utf8')
}

const LOG_ENTRY_RE = /^## \[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\]/

/** log.md 归并（§12.2）：按条目时间戳归并排序，注入 [project:<id>] 前缀。 */
function mergeLogFiles(srcLog: string, sharedLog: string, projectId: string): void {
  const shared = fs.existsSync(sharedLog) ? fs.readFileSync(sharedLog, 'utf8') : ''
  const src = fs.readFileSync(srcLog, 'utf8')
  const parseEntries = (text: string): { preamble: string; entries: Array<{ ts: string; body: string[] }> } => {
    const entries: Array<{ ts: string; body: string[] }> = []
    const preambleLines: string[] = []
    const lines = text.split(/\r?\n/)
    let current: { ts: string; body: string[] } | undefined
    for (const line of lines) {
      const m = line.match(LOG_ENTRY_RE)
      if (m) {
        if (current) entries.push({ ts: current.ts, body: current.body })
        current = { ts: `${m[1]} ${m[2]}`, body: [line] }
      } else if (current) {
        current.body.push(line)
      } else {
        // P1-5：首个条目之前的行（模板头/preamble）不丢弃
        preambleLines.push(line)
      }
    }
    if (current) entries.push({ ts: current.ts, body: current.body })
    return { preamble: preambleLines.join('\n'), entries }
  }
  const srcParsed = parseEntries(src)
  const sharedParsed = parseEntries(shared)
  const prefixed = srcParsed.entries.map((e) => ({
    ts: e.ts,
    body: e.body.map((l) => (LOG_ENTRY_RE.test(l) ? l.replace(/^## \[([^\]]+)\]/, `## [$1] [project:${projectId}]`) : l))
  }))
  const existingBodies = new Set(sharedParsed.entries.map((e) => e.body.join('\n')))
  const merged = [...sharedParsed.entries, ...prefixed.filter((e) => !existingBodies.has(e.body.join('\n')))]
    .sort((a, b) => a.ts.localeCompare(b.ts))
  // P1-5：preamble（共享库优先，缺失时用来源侧）保留在首部
  const preamble = sharedParsed.preamble.trim().length > 0 ? sharedParsed.preamble : srcParsed.preamble
  const body = merged.map((e) => e.body.join('\n')).join('\n').replace(/\n{3,}/g, '\n\n')
  const out = preamble.trim().length > 0 ? `${preamble.replace(/\s*$/, '')}\n\n${body}` : body
  fs.writeFileSync(sharedLog, out.endsWith('\n') ? out : `${out}\n`, 'utf8')
}

/** SCHEMA 三分支（§12.2）：哈希 = 旧默认 → 替换新版；已修改 → 存 SCHEMA.legacy-<projectId>.md；缺失 → 忽略。 */
function migrateSchemaFile(srcSchema: string, sharedSchema: string, newSchemaContent: string, projectId: string): void {
  if (!fs.existsSync(srcSchema)) return
  const content = fs.readFileSync(srcSchema, 'utf8')
  // BLK-2：真实 v1 全文 LF/CRLF 双哈希（评审实证 7caddb2e…/b2638fbd…）
  const legacyDefaultHashes = new Set([
    sha256(LEGACY_DEFAULT_SCHEMA_MD_V1),
    sha256(LEGACY_DEFAULT_SCHEMA_MD_V1.replace(/\r?\n/g, '\r\n'))
  ])
  if (legacyDefaultHashes.has(sha256(content))) {
    // 未修改 → 共享库用新版模板（共享库已有 SCHEMA 则不动）
    if (!fs.existsSync(sharedSchema)) {
      fs.mkdirSync(path.dirname(sharedSchema), { recursive: true })
      fs.writeFileSync(sharedSchema, newSchemaContent, 'utf8')
    }
    return
  }
  const target = path.join(path.dirname(sharedSchema), `SCHEMA.legacy-${projectId}.md`)
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, content, 'utf8')
  }
  // BLK-2 连带：共享库尚无 SCHEMA 时补写新版模板（否则 isWikiInitialized=false、注入为 null）
  if (!fs.existsSync(sharedSchema)) {
    fs.mkdirSync(path.dirname(sharedSchema), { recursive: true })
    fs.writeFileSync(sharedSchema, newSchemaContent, 'utf8')
  }
}

/** 旧目录收尾：整目录改名 <root>.migrated-{YYYYMMDD-HHmmss}/（永不自动删除）。 */
/** P2-4：根目录名单段校验（防 ../ 逃逸）。 */
function safeRootName(name: string): string | undefined {
  const trimmed = (name || '').trim()
  if (!trimmed || /[\/]/.test(trimmed) || trimmed === '.' || trimmed === '..') return undefined
  return trimmed
}

function renameLegacyRootAway(srcRoot: string, now: Date): string {
  // P2-1：§12.2 格式 {YYYYMMDD-HHmmss}（避免 toISOString 毫秒小数点尾随）
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const dest = `${srcRoot}.migrated-${ts}`
  fs.renameSync(srcRoot, dest)
  return dest
}



function loadMigrationState(db: AppDatabase): WikiConfig['migration'] {
  const raw = getConfigValue(db, CONFIG_KEYS.wiki)
  if (!raw) return { status: 'idle' }
  try {
    const parsed = JSON.parse(raw) as Partial<WikiConfig>
    return parsed.migration ?? { status: 'idle' }
  } catch {
    return { status: 'idle' }
  }
}

function persistMigrationState(
  db: AppDatabase,
  wikiConfig: WikiConfig,
  migration: NonNullable<WikiConfig['migration']>,
  legacyRootAliases?: string[],
  resetRootPath?: boolean
): void {
  const raw = getConfigValue(db, CONFIG_KEYS.wiki)
  let cur: Partial<WikiConfig> = {}
  if (raw) {
    try {
      cur = JSON.parse(raw) as Partial<WikiConfig>
    } catch {
      cur = {}
    }
  }
  const next: WikiConfig = { ...wikiConfig, ...cur, migration }
  // T2.3：别名同时写顶层 legacyRootAliases（挂载层消费的字段）
  if (legacyRootAliases) next.legacyRootAliases = legacyRootAliases
  // BLK-4：存量自定义 rootPath 迁移完成后重置为默认（物理目录已在迁移中归位），否则词汇/物理解耦断裂
  if (resetRootPath) next.rootPath = DEFAULT_WIKI_ROOT_DIRNAME
  setConfigValue(db, CONFIG_KEYS.wiki, JSON.stringify(next))
}

/**
 * 执行存量迁移（§12.2）：幂等可重试；报告持久化至 config.wiki.migration（§10.2）；
 * 完成后把自定义根名写入 config.wiki.legacyRootAliases（§12.2，T2.3）。
 */
export async function migrateLegacyWikis(options: MigrateLegacyWikisOptions): Promise<WikiMigrationReport> {
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const report: WikiMigrationReport = { startedAt, profiles: [], conflicts: [], renames: [] }
  // BLK-3/BLK-4：合并目标恒为默认物理目录 {userData}/llm-wiki——存量自定义 rootPath 是旧语义
  // （workDir 内根名），迁移后配置重置为默认值，旧名转入 legacyRootAliases（§6.3/§12.2）
  const sharedRoot = path.join(options.userDataPath, DEFAULT_WIKI_ROOT_DIRNAME)
  const storedCustomRoot = safeRootName(options.wikiConfig.rootPath ?? '')
    && options.wikiConfig.rootPath !== DEFAULT_WIKI_ROOT_DIRNAME
    ? options.wikiConfig.rootPath
    : undefined
  // 共享库此前被 P1 init 建在旧 rootPath 下时，物理目录归位默认（默认侧已有库则保留两侧、旧目录交别名通道）
  if (storedCustomRoot) {
    const legacyShared = path.join(options.userDataPath, storedCustomRoot)
    if (fs.existsSync(legacyShared)) {
      if (!fs.existsSync(sharedRoot)) {
        // 默认侧无共享库：整目录归位
        fs.renameSync(legacyShared, sharedRoot)
      } else {
        // 两侧并存：旧物理目录改名保留（§12.2 永不自动删除；内容不丢，默认侧为权威库）
        const ts = now().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        fs.renameSync(legacyShared, `${legacyShared}.pre-migrated-${ts}`)
      }
    }
  }
  const changedVocabPaths = new Set<string>()
  const aliasNames = new Set<string>()

  const targets: LegacyRootCandidate[] = [
    ...options.profiles.flatMap((p) => {
      const candidates = [{ workDir: p.workDir, rootDirName: DEFAULT_WIKI_ROOT_DIRNAME }]
      // BLK-3：存量自定义 rootPath 与默认根同等对待（§12.1/§12.2）——自动并入管线
      if (storedCustomRoot) candidates.push({ workDir: p.workDir, rootDirName: storedCustomRoot })
      return candidates
    }),
    ...(options.extraLegacyRoots ?? [])
  ]
    .map((c) => ({ ...c, rootDirName: safeRootName(c.rootDirName) ?? '' }))
    .filter((c) => c.rootDirName)
  const profileNameByWorkDir = new Map(options.profiles.map((p) => [p.workDir, p]))

  try {
    for (const candidate of targets) {
      const srcRoot = path.join(candidate.workDir, candidate.rootDirName)
      if (!fs.existsSync(srcRoot) || !looksLikeLegacyWikiRoot(srcRoot)) {
        report.profiles = [...(report.profiles ?? []), { workDir: candidate.workDir, rootDirName: candidate.rootDirName, status: 'skipped' }]
        continue
      }
      const projectId = options.db
        ? registerWikiProject(options.db, {
            workDir: candidate.workDir,
            profileId: profileNameByWorkDir.get(candidate.workDir)?.profileId,
            profileName: profileNameByWorkDir.get(candidate.workDir)?.profileName
          }).projectId
        : computeProjectId(candidate.workDir)

      try {
        // raw/* → raw/<projectId>/（重名由项目目录天然隔离，§12.2）
        const srcRaw = path.join(srcRoot, 'raw')
        if (fs.existsSync(srcRaw)) {
          const destRaw = path.join(sharedRoot, 'raw', projectId)
          fs.mkdirSync(destRaw, { recursive: true })
          for (const ent of fs.readdirSync(srcRaw, { withFileTypes: true })) {
            if (!ent.isFile()) continue
            const srcAbs = path.join(srcRaw, ent.name)
            const destAbs = path.join(destRaw, ent.name)
            if (fs.existsSync(destAbs)) continue // 幂等跳过
            await copyFileLocked(srcAbs, destAbs)
            changedVocabPaths.add(`${WIKI_VOCABULARY_PREFIX}/raw/${projectId}/${ent.name}`)
          }
        }

        // wiki/** 页面合并（index/log 单独归并）
        await mergeWikiPages(
          path.join(srcRoot, 'wiki'),
          path.join(sharedRoot, 'wiki'),
          projectId,
          report,
          WIKI_VOCABULARY_PREFIX,
          (paths) => paths.forEach((p) => changedVocabPaths.add(p))
        )
        const srcIndex = path.join(srcRoot, 'wiki', 'index.md')
        const sharedIndex = path.join(sharedRoot, 'wiki', 'index.md')
        if (fs.existsSync(srcIndex)) {
          await withWikiWriteMutex(sharedIndex, async () => {
            mergeIndexFiles(srcIndex, sharedIndex, projectId)
          })
          changedVocabPaths.add(`${WIKI_VOCABULARY_PREFIX}/wiki/index.md`)
        }
        const srcLog = path.join(srcRoot, 'wiki', 'log.md')
        const sharedLog = path.join(sharedRoot, 'wiki', 'log.md')
        if (fs.existsSync(srcLog)) {
          await withWikiWriteMutex(sharedLog, async () => {
            mergeLogFiles(srcLog, sharedLog, projectId)
          })
          changedVocabPaths.add(`${WIKI_VOCABULARY_PREFIX}/wiki/log.md`)
        }

        // SCHEMA 三分支
        migrateSchemaFile(path.join(srcRoot, 'SCHEMA.md'), path.join(sharedRoot, 'SCHEMA.md'), DEFAULT_SCHEMA_MD, projectId)

        // 项目级技能副本清理（R1 覆盖陷阱）
        removeProjectWikiSkillCopy(candidate.workDir)

        // 旧目录改名（含自定义根；幂等：迁移过则 srcRoot 已不存在）
        renameLegacyRootAway(srcRoot, now())

        // 自定义根注册只读别名（T2.3；默认根名不注册）
        if (candidate.rootDirName !== DEFAULT_WIKI_ROOT_DIRNAME) aliasNames.add(candidate.rootDirName)

        report.profiles = [...(report.profiles ?? []), { workDir: candidate.workDir, rootDirName: candidate.rootDirName, projectId, status: 'migrated' }]
      } catch (e) {
        report.profiles = [...(report.profiles ?? []), {
          workDir: candidate.workDir,
          rootDirName: candidate.rootDirName,
          projectId,
          status: 'failed',
          error: e instanceof Error ? e.message : String(e)
        }]
      }
    }

    // T2.3：别名注册——写 config.wiki.legacyRootAliases
    if (aliasNames.size > 0) {
      const prev = loadMigrationState(options.db)
      const aliases = new Set([...(options.wikiConfig.legacyRootAliases ?? []), ...(prev?.legacyRootAliases ?? []), ...aliasNames])
      const aliasList = [...aliases]
      persistMigrationState(options.db, options.wikiConfig, { status: 'completed', completedAt: now().toISOString(), report, legacyRootAliases: aliasList }, aliasList, Boolean(storedCustomRoot))
      options.wikiConfig.legacyRootAliases = aliasList
      if (storedCustomRoot) options.wikiConfig.rootPath = DEFAULT_WIKI_ROOT_DIRNAME
    } else {
      persistMigrationState(options.db, options.wikiConfig, { status: 'completed', completedAt: now().toISOString(), report }, storedCustomRoot ? [...(options.wikiConfig.legacyRootAliases ?? []), storedCustomRoot] : undefined, Boolean(storedCustomRoot))
      if (storedCustomRoot) {
        options.wikiConfig.legacyRootAliases = [...(options.wikiConfig.legacyRootAliases ?? []), storedCustomRoot]
        options.wikiConfig.rootPath = DEFAULT_WIKI_ROOT_DIRNAME
      }
    }
    report.completedAt = now().toISOString()
  } catch (e) {
    persistMigrationState(options.db, options.wikiConfig, { status: 'failed', report, completedAt: now().toISOString() })
    throw e
  }

  if (changedVocabPaths.size > 0) {
    options.onFileTreeChange?.([...changedVocabPaths])
  }
  return report
}
