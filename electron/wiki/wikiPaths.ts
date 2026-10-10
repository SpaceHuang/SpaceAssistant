import path from 'path'
import type { WikiConfig } from '../../src/shared/domainTypes'
import { WIKI_VOCABULARY_PREFIX, DEFAULT_WIKI_ROOT_DIRNAME } from '../../src/shared/wikiConstants'

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
  if (!wikiConfig.enabled) return 'other'
  // BLK-4（D9/§6.3）：分类基准恒为词汇常量，与 rootPath（物理目录名）解耦
  void workDir
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const wikiRootRel = WIKI_VOCABULARY_PREFIX
  if (normalized === `${wikiRootRel}/SCHEMA.md`) return 'schema'
  if (normalized === `${wikiRootRel}/raw` || normalized.startsWith(`${wikiRootRel}/raw/`)) return 'raw'
  if (normalized === `${wikiRootRel}/wiki` || normalized.startsWith(`${wikiRootRel}/wiki/`)) return 'wiki'
  return 'other'
}

export function isUnderWikiRaw(workDir: string, wikiConfig: WikiConfig, relPath: string): boolean {
  return wikiConfig.enabled && classifyWikiPath(workDir, wikiConfig, relPath) === 'raw'
}

export function wikiSchemaRelPath(wikiConfig: WikiConfig): string {
  void wikiConfig
  return `${WIKI_VOCABULARY_PREFIX}/SCHEMA.md`
}

export function wikiIndexRelPath(wikiConfig: WikiConfig): string {
  void wikiConfig
  return `${WIKI_VOCABULARY_PREFIX}/wiki/index.md`
}
