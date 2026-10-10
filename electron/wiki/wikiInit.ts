import fs from 'fs'
import path from 'path'
import type { SkillDefinition } from '../../src/shared/domainTypes'
import { getProjectSkillsDir, getUserSkillsDir } from '../skills/skillPaths'
import { readSkillFromDirectory } from '../skills/skillParser'
import { assertInsideDir } from '../skills/skillPaths'
import { DEFAULT_INDEX_MD, DEFAULT_LOG_MD, DEFAULT_SCHEMA_MD, BUNDLED_LLM_WIKI_SKILL_MD, WIKI_SUBDIRS } from './wikiTemplates'
import { resolveWikiRootAbs } from './wikiPaths'
import { DEFAULT_WIKI_ROOT_DIRNAME } from '../../src/shared/wikiConstants'
import type { WikiConfig } from '../../src/shared/domainTypes'
import { WIKI_VOCABULARY_PREFIX } from '../../src/shared/wikiConstants'

/** 共享库物理根：{userData}/<wikiConfig.rootPath>（T1.12a；目录名读配置 D9）。 */
export function resolveSharedWikiRoot(userDataPath: string, wikiConfig: WikiConfig): string {
  return path.join(userDataPath, wikiConfig.rootPath || DEFAULT_WIKI_ROOT_DIRNAME)
}

async function writeSkillToProject(workDir: string, overwrite: boolean): Promise<{ installed: boolean; skill?: SkillDefinition }> {
  const projectDir = getProjectSkillsDir(workDir)
  if (!projectDir) return { installed: false }

  const targetDir = path.join(projectDir, WIKI_VOCABULARY_PREFIX)
  assertInsideDir(projectDir, targetDir)

  if (fs.existsSync(targetDir) && !overwrite) {
    return { installed: false, skill: readSkillFromDirectory(targetDir, 'project') }
  }

  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(path.join(targetDir, 'SKILL.md'), BUNDLED_LLM_WIKI_SKILL_MD, 'utf8')
  return { installed: true, skill: readSkillFromDirectory(targetDir, 'project') }
}

export function isWikiInitialized(workDir: string, wikiConfig: WikiConfig, userDataPath?: string): boolean {
  const root = userDataPath ? resolveSharedWikiRoot(userDataPath, wikiConfig) : resolveWikiRootAbs(workDir, wikiConfig)
  return (
    fs.existsSync(path.join(root, 'SCHEMA.md')) &&
    fs.existsSync(path.join(root, 'wiki', 'index.md')) &&
    fs.existsSync(path.join(root, 'wiki', 'log.md'))
  )
}

export async function installBundledLlmWikiSkill(
  workDir: string,
  overwrite = false,
  userDataPath?: string
): Promise<{ installed: boolean; skill?: SkillDefinition }> {
  // T1.13：技能从项目级升级为用户级（{userData}/skills/llm-wiki/）；迁移时清理项目级副本（R1 覆盖陷阱）
  if (userDataPath) return writeSkillToUserLevel(userDataPath, overwrite)
  return writeSkillToProject(workDir, overwrite)
}

async function writeSkillToUserLevel(userDataPath: string, overwrite: boolean): Promise<{ installed: boolean; skill?: SkillDefinition }> {
  const userDir = getUserSkillsDir(userDataPath)
  const targetDir = path.join(userDir, WIKI_VOCABULARY_PREFIX)
  assertInsideDir(userDir, targetDir)

  if (fs.existsSync(targetDir) && !overwrite) {
    return { installed: false, skill: readSkillFromDirectory(targetDir, 'user') }
  }

  fs.mkdirSync(userDir, { recursive: true })
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(path.join(targetDir, 'SKILL.md'), BUNDLED_LLM_WIKI_SKILL_MD, 'utf8')
  return { installed: true, skill: readSkillFromDirectory(targetDir, 'user') }
}

/** T1.13④：迁移/初始化时删除项目级旧副本（user→project→bundled 覆盖序，残留副本会持续覆盖用户级新版）。 */
export function removeProjectWikiSkillCopy(workDir: string): boolean {
  const projectDir = getProjectSkillsDir(workDir)
  if (!projectDir) return false
  const targetDir = path.join(projectDir, WIKI_VOCABULARY_PREFIX)
  if (!fs.existsSync(targetDir)) return false
  fs.rmSync(targetDir, { recursive: true, force: true })
  return true
}

export type WikiInitOptions = {
  overwrite?: boolean
  installSkill?: boolean
  /** 共享库 userData 目录（T1.12a：传入时骨架建 {userData}/<rootPath>；缺省保持 workDir 旧形态） */
  userDataPath?: string
}

export type WikiInitResult =
  | { ok: true; rootPath: string; skillInstalled: boolean }
  | { ok: false; error: string }

export async function initWikiStructure(
  workDir: string,
  wikiConfig: WikiConfig,
  options: WikiInitOptions = {}
): Promise<WikiInitResult> {
  if (!workDir.trim()) return { ok: false, error: '工作目录未配置' }

  const root = options.userDataPath ? resolveSharedWikiRoot(options.userDataPath, wikiConfig) : resolveWikiRootAbs(workDir, wikiConfig)
  const already = isWikiInitialized(workDir, wikiConfig, options.userDataPath)

  if (already && !options.overwrite) {
    let skillInstalled = false
    if (options.installSkill !== false) {
      const r = await installBundledLlmWikiSkill(workDir, false, options.userDataPath)
      skillInstalled = r.installed
    }
    const rootRel = wikiConfig.rootPath.replace(/\\/g, '/').replace(/^\/+/, '')
    return { ok: true, rootPath: rootRel, skillInstalled }
  }

  try {
    fs.mkdirSync(root, { recursive: true })
    for (const sub of WIKI_SUBDIRS) {
      fs.mkdirSync(path.join(root, sub), { recursive: true })
    }
    fs.mkdirSync(path.join(root, 'wiki', 'projects'), { recursive: true })

    const schemaPath = path.join(root, 'SCHEMA.md')
    const indexPath = path.join(root, 'wiki', 'index.md')
    const logPath = path.join(root, 'wiki', 'log.md')

    if (!fs.existsSync(schemaPath) || options.overwrite) {
      fs.writeFileSync(schemaPath, DEFAULT_SCHEMA_MD, 'utf8')
    }
    if (!fs.existsSync(indexPath) || options.overwrite) {
      fs.writeFileSync(indexPath, DEFAULT_INDEX_MD, 'utf8')
    }
    if (!fs.existsSync(logPath) || options.overwrite) {
      fs.writeFileSync(logPath, DEFAULT_LOG_MD, 'utf8')
    }

    const metaPath = path.join(root, '.wiki-meta.json')
    if (!fs.existsSync(metaPath)) {
      // schemaVersion 2 + storage:shared（§6.1；新旧结构判定依据，不覆盖旧值）
      fs.writeFileSync(
        metaPath,
        JSON.stringify(
          {
            schemaVersion: 2,
            storage: 'shared',
            initializedAt: new Date().toISOString(),
            ingestedRawPaths: []
          },
          null,
          2
        ),
        'utf8'
      )
    }

    let skillInstalled = false
    if (options.installSkill !== false) {
      const r = await installBundledLlmWikiSkill(workDir, Boolean(options.overwrite), options.userDataPath)
      skillInstalled = r.installed
    }

    const rootRel = wikiConfig.rootPath.replace(/\\/g, '/').replace(/^\/+/, '')
    return { ok: true, rootPath: rootRel, skillInstalled }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export type WikiRootRenameResult = { ok: true } | { ok: false; error: string }

/**
 * 共享库受控改名（T1.12a③，§6.3）：rename 物理目录；广播由调用方钩子触发；
 * 失败（目标已存在等）时返回 error，配置值由调用方保持不变（回滚语义）。
 */
export function renameWikiRoot(input: {
  userDataPath: string
  currentRootPath: string
  newRootPath: string
  broadcast?: () => void
}): WikiRootRenameResult {
  const newRoot = (input.newRootPath || '').trim()
  if (!newRoot || /[\/]/.test(newRoot) || newRoot === '.' || newRoot === '..') {
    return { ok: false, error: '目录名只能是不含路径分隔符的单段名称' }
  }
  const currentRoot = (input.currentRootPath || DEFAULT_WIKI_ROOT_DIRNAME).trim() || DEFAULT_WIKI_ROOT_DIRNAME
  if (newRoot === currentRoot) return { ok: true }
  const src = path.join(input.userDataPath, currentRoot)
  const dest = path.join(input.userDataPath, newRoot)
  if (!fs.existsSync(src)) return { ok: false, error: '共享库目录不存在，无需改名' }
  if (fs.existsSync(dest)) return { ok: false, error: '目标目录名已被占用' }
  try {
    fs.renameSync(src, dest)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  try {
    input.broadcast?.()
  } catch {
    // 广播失败不回滚 rename（渲染端会经版本号自愈）
  }
  return { ok: true }
}

export function readWikiSchema(workDir: string, wikiConfig: WikiConfig, userDataPath?: string): string | null {
  // T1.14：注入经共享根读全局 SCHEMA（所有 workDir 的会话注入同一份）
  const root = userDataPath ? resolveSharedWikiRoot(userDataPath, wikiConfig) : resolveWikiRootAbs(workDir, wikiConfig)
  const schemaPath = path.join(root, 'SCHEMA.md')
  if (!fs.existsSync(schemaPath)) return null
  return fs.readFileSync(schemaPath, 'utf8')
}
