import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WikiConfig } from '../../src/shared/domainTypes'
import { DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import {
  classifyWikiPath,
  isUnderWikiRaw,
  resolveWikiRootAbs,
  wikiIndexRelPath,
  wikiSchemaRelPath
} from './wikiPaths'
import { initWikiStructure, isWikiInitialized, readWikiSchema } from './wikiInit'
import { getWikiStatus } from './wikiStatus'

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

function makeWorkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-wiki-'))
  tmpDirs.push(dir)
  return dir
}

const wikiConfig: WikiConfig = { ...DEFAULT_WIKI_CONFIG, enabled: true }

describe('wikiPaths', () => {
  it('classifies raw and wiki paths', () => {
    const workDir = makeWorkDir()
    expect(classifyWikiPath(workDir, wikiConfig, 'llm-wiki/raw/foo.md')).toBe('raw')
    expect(classifyWikiPath(workDir, wikiConfig, 'llm-wiki/wiki/index.md')).toBe('wiki')
    expect(classifyWikiPath(workDir, wikiConfig, 'llm-wiki/SCHEMA.md')).toBe('schema')
    expect(isUnderWikiRaw(workDir, wikiConfig, 'llm-wiki/raw/x.txt')).toBe(true)
    expect(isUnderWikiRaw(workDir, wikiConfig, 'llm-wiki/wiki/x.md')).toBe(false)
  })

  it('returns schema and index rel paths', () => {
    expect(wikiSchemaRelPath(wikiConfig)).toBe('llm-wiki/SCHEMA.md')
    expect(wikiIndexRelPath(wikiConfig)).toBe('llm-wiki/wiki/index.md')
    expect(resolveWikiRootAbs(makeWorkDir(), wikiConfig)).toContain('llm-wiki')
  })
})

describe('wikiInit', () => {
  it('creates standard wiki structure', async () => {
    const workDir = makeWorkDir()
    const result = await initWikiStructure(workDir, wikiConfig)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(isWikiInitialized(workDir, wikiConfig)).toBe(true)
    expect(readWikiSchema(workDir, wikiConfig)).toContain('Ingest 工作流')
    const status = getWikiStatus(workDir, wikiConfig)
    expect(status.initialized).toBe(true)
    expect(status.pageCount).toBeGreaterThanOrEqual(2)
  })

  it('installs bundled llm-wiki skill', async () => {
    const workDir = makeWorkDir()
    const result = await initWikiStructure(workDir, wikiConfig, { installSkill: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skillInstalled).toBe(true)
    expect(fs.existsSync(path.join(workDir, '.space-skills', 'llm-wiki', 'SKILL.md'))).toBe(true)
  })
})
