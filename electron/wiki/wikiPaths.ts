import path from 'path'
import type { WikiConfig } from '../../src/shared/domainTypes'
import { WIKI_VOCABULARY_PREFIX } from '../../src/shared/wikiConstants'

export const DEFAULT_WIKI_ROOT = WIKI_VOCABULARY_PREFIX

/** 旧语义遗留（workDir 内根，仅供存量迁移检测派生）；新语义下 rootPath 是 userData 物理目录名。 */
export function resolveWikiRootAbs(workDir: string, wikiConfig: WikiConfig): string {
  const rootRel = (wikiConfig.rootPath || DEFAULT_WIKI_ROOT).replace(/\\/g, '/').replace(/^\/+/, '')
  return path.resolve(workDir, rootRel)
}

export function resolveWikiRelPath(workDir: string, wikiConfig: WikiConfig, relPath: string): string {
  // BLK-4（D9/§6.3）：词汇前缀恒为 WIKI_VOCABULARY_PREFIX——rootPath 是 userData 物理目录名，
  // 不参与词汇判定（改名后 llm-wiki/... 词汇仍必须命中分类）
  void wikiConfig
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const wikiRootRel = WIKI_VOCABULARY_PREFIX
  if (normalized === wikiRootRel || normalized.startsWith(`${wikiRootRel}/`)) {
    return normalized
  }
  const abs = path.resolve(workDir, normalized)
  const rel = path.relative(workDir, abs).replace(/\\/g, '/')
  return rel
}

export type WikiPathKind = 'raw' | 'wiki' | 'schema' | 'other'

export function classifyWikiPath(workDir: string, wikiConfig: WikiConfig, relPath: string): WikiPathKind {
  // BLK-4（D9/§6.3）：分类基准恒为词汇常量，与 rootPath（物理目录名）解耦
  // BLK-5 残余：结构段比较大小写不敏感——挂载命中大小写变体（llm-wiki/RAW/x）时
  // vocabularyPath 保留入参后缀形态，raw deny 语义不得因大小写漏判
  void workDir
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
  const wikiRootRel = WIKI_VOCABULARY_PREFIX
  if (normalized === `${wikiRootRel}/SCHEMA.md`.toLowerCase()) return 'schema'
  if (normalized === `${wikiRootRel}/raw` || normalized.startsWith(`${wikiRootRel}/raw/`)) return 'raw'
  if (normalized === `${wikiRootRel}/wiki` || normalized.startsWith(`${wikiRootRel}/wiki/`)) return 'wiki'
  return 'other'
}

export function isUnderWikiRaw(workDir: string, wikiConfig: WikiConfig, relPath: string): boolean {
  return classifyWikiPath(workDir, wikiConfig, relPath) === 'raw'
}

export function wikiSchemaRelPath(wikiConfig: WikiConfig): string {
  void wikiConfig
  return `${WIKI_VOCABULARY_PREFIX}/SCHEMA.md`
}

export function wikiIndexRelPath(wikiConfig: WikiConfig): string {
  void wikiConfig
  return `${WIKI_VOCABULARY_PREFIX}/wiki/index.md`
}

export const WIKI_SERVICE_DIR = '.wiki-service'
export const WIKI_BOOTSTRAP_SEAL = '.wiki-service-bootstrap.json'
export const WIKI_CATALOG_PATH = `${WIKI_SERVICE_DIR}/catalog.json`

export function normalizeWikiRelativePath(relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) {
    throw new Error('Wiki relative path is invalid.')
  }
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new Error('Wiki path must be relative.')
  const segments = normalized.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Wiki path traversal is not allowed.')
  return segments.join(path.posix.sep)
}

export function resolveWikiServicePath(wikiRoot: string, relativePath: string): string {
  const normalized = normalizeWikiRelativePath(relativePath)
  const root = path.resolve(wikiRoot)
  const target = path.resolve(root, normalized)
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Wiki path is outside the root.')
  return target
}
