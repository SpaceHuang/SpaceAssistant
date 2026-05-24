import fs from 'fs'
import path from 'path'
import type { SkillDefinition } from '../../src/shared/domainTypes'
import { getProjectSkillsDir } from '../skills/skillPaths'
import { readSkillFromDirectory } from '../skills/skillParser'
import { assertInsideDir } from '../skills/skillPaths'
import { DEFAULT_INDEX_MD, DEFAULT_LOG_MD, DEFAULT_SCHEMA_MD, BUNDLED_LLM_WIKI_SKILL_MD, WIKI_SUBDIRS } from './wikiTemplates'
import { resolveWikiRootAbs } from './wikiPaths'
import type { WikiConfig } from '../../src/shared/domainTypes'

async function writeSkillToProject(workDir: string, overwrite: boolean): Promise<{ installed: boolean; skill?: SkillDefinition }> {
  const projectDir = getProjectSkillsDir(workDir)
  if (!projectDir) return { installed: false }

  const targetDir = path.join(projectDir, 'llm-wiki')
  assertInsideDir(projectDir, targetDir)

  if (fs.existsSync(targetDir) && !overwrite) {
    return { installed: false, skill: readSkillFromDirectory(targetDir, 'project') }
  }

  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(path.join(targetDir, 'SKILL.md'), BUNDLED_LLM_WIKI_SKILL_MD, 'utf8')
  return { installed: true, skill: readSkillFromDirectory(targetDir, 'project') }
}

export function isWikiInitialized(workDir: string, wikiConfig: WikiConfig): boolean {
  const root = resolveWikiRootAbs(workDir, wikiConfig)
  return (
    fs.existsSync(path.join(root, 'SCHEMA.md')) &&
    fs.existsSync(path.join(root, 'wiki', 'index.md')) &&
    fs.existsSync(path.join(root, 'wiki', 'log.md'))
  )
}

export async function installBundledLlmWikiSkill(
  workDir: string,
  overwrite = false
): Promise<{ installed: boolean; skill?: SkillDefinition }> {
  return writeSkillToProject(workDir, overwrite)
}

export type WikiInitOptions = {
  overwrite?: boolean
  installSkill?: boolean
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

  const root = resolveWikiRootAbs(workDir, wikiConfig)
  const already = isWikiInitialized(workDir, wikiConfig)

  if (already && !options.overwrite) {
    let skillInstalled = false
    if (options.installSkill !== false) {
      const r = await installBundledLlmWikiSkill(workDir, false)
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
    if (!fs.existsSync(metaPath) || options.overwrite) {
      fs.writeFileSync(
        metaPath,
        JSON.stringify(
          {
            schemaVersion: 1,
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
      const r = await installBundledLlmWikiSkill(workDir, Boolean(options.overwrite))
      skillInstalled = r.installed
    }

    const rootRel = wikiConfig.rootPath.replace(/\\/g, '/').replace(/^\/+/, '')
    return { ok: true, rootPath: rootRel, skillInstalled }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function readWikiSchema(workDir: string, wikiConfig: WikiConfig): string | null {
  const schemaPath = path.join(resolveWikiRootAbs(workDir, wikiConfig), 'SCHEMA.md')
  if (!fs.existsSync(schemaPath)) return null
  return fs.readFileSync(schemaPath, 'utf8')
}
