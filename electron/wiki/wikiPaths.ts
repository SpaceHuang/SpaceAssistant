import path from 'path'
import type { WikiConfig } from '../../src/shared/domainTypes'

export const DEFAULT_WIKI_ROOT = 'llm-wiki'

export function resolveWikiRootAbs(workDir: string, wikiConfig: WikiConfig): string {
  const rootRel = (wikiConfig.rootPath || DEFAULT_WIKI_ROOT).replace(/\\/g, '/').replace(/^\/+/, '')
  return path.resolve(workDir, rootRel)
}

export function resolveWikiRelPath(workDir: string, wikiConfig: WikiConfig, relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const wikiRootRel = (wikiConfig.rootPath || DEFAULT_WIKI_ROOT).replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized === wikiRootRel || normalized.startsWith(`${wikiRootRel}/`)) {
    return normalized
  }
  const abs = path.resolve(workDir, normalized)
  const wikiRootAbs = resolveWikiRootAbs(workDir, wikiConfig)
  const rel = path.relative(workDir, abs).replace(/\\/g, '/')
  return rel
}

export type WikiPathKind = 'raw' | 'wiki' | 'schema' | 'other'

export function classifyWikiPath(workDir: string, wikiConfig: WikiConfig, relPath: string): WikiPathKind {
  if (!wikiConfig.enabled) return 'other'
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const wikiRootRel = (wikiConfig.rootPath || DEFAULT_WIKI_ROOT).replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized === `${wikiRootRel}/SCHEMA.md`) return 'schema'
  if (normalized === `${wikiRootRel}/raw` || normalized.startsWith(`${wikiRootRel}/raw/`)) return 'raw'
  if (normalized === `${wikiRootRel}/wiki` || normalized.startsWith(`${wikiRootRel}/wiki/`)) return 'wiki'
  return 'other'
}

export function isUnderWikiRaw(workDir: string, wikiConfig: WikiConfig, relPath: string): boolean {
  return wikiConfig.enabled && classifyWikiPath(workDir, wikiConfig, relPath) === 'raw'
}

export function wikiSchemaRelPath(wikiConfig: WikiConfig): string {
  const root = (wikiConfig.rootPath || DEFAULT_WIKI_ROOT).replace(/\\/g, '/').replace(/^\/+/, '')
  return `${root}/SCHEMA.md`
}

export function wikiIndexRelPath(wikiConfig: WikiConfig): string {
  const root = (wikiConfig.rootPath || DEFAULT_WIKI_ROOT).replace(/\\/g, '/').replace(/^\/+/, '')
  return `${root}/wiki/index.md`
}
