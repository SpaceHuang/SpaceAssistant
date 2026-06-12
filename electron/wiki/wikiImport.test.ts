import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WikiConfig } from '../../src/shared/domainTypes'
import { DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import { initWikiStructure } from './wikiInit'
import { importRawFromWorkDir, wikiImportFileTreeChange } from './wikiImport'

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

function makeWorkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-wiki-import-'))
  tmpDirs.push(dir)
  return dir
}

const wikiConfig: WikiConfig = { ...DEFAULT_WIKI_CONFIG, enabled: true }

describe('wikiImport', () => {
  it('copies external text file into raw', async () => {
    const workDir = makeWorkDir()
    await initWikiStructure(workDir, wikiConfig, { installSkill: false })
    fs.mkdirSync(path.join(workDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(workDir, 'docs', 'note.md'), '# hello')

    const result = await importRawFromWorkDir(workDir, wikiConfig, 'docs/note.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.copied).toBe(true)
    expect(result.rawRelPath).toBe('llm-wiki/raw/note.md')
    expect(fs.existsSync(path.join(workDir, 'docs', 'note.md'))).toBe(true)
    expect(fs.readFileSync(path.join(workDir, 'llm-wiki', 'raw', 'note.md'), 'utf8')).toBe('# hello')
  })

  it('auto-renames when raw basename exists', async () => {
    const workDir = makeWorkDir()
    await initWikiStructure(workDir, wikiConfig, { installSkill: false })
    fs.mkdirSync(path.join(workDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(workDir, 'docs', 'note.md'), 'new')
    fs.mkdirSync(path.join(workDir, 'llm-wiki', 'raw'), { recursive: true })
    fs.writeFileSync(path.join(workDir, 'llm-wiki', 'raw', 'note.md'), 'old')

    const result = await importRawFromWorkDir(workDir, wikiConfig, 'docs/note.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.copied).toBe(true)
    expect(result.rawRelPath).toMatch(/^llm-wiki\/raw\/note-/)
    expect(result.rawRelPath).not.toBe('llm-wiki/raw/note.md')
  })

  it('skips copy for files already in raw', async () => {
    const workDir = makeWorkDir()
    await initWikiStructure(workDir, wikiConfig, { installSkill: false })
    fs.writeFileSync(path.join(workDir, 'llm-wiki', 'raw', 'x.md'), 'raw')

    const result = await importRawFromWorkDir(workDir, wikiConfig, 'llm-wiki/raw/x.md')
    expect(result).toEqual({ ok: true, rawRelPath: 'llm-wiki/raw/x.md', copied: false })
  })

  it('rejects wiki pages and binary files', async () => {
    const workDir = makeWorkDir()
    await initWikiStructure(workDir, wikiConfig, { installSkill: false })
    fs.mkdirSync(path.join(workDir, 'llm-wiki', 'wiki'), { recursive: true })
    fs.writeFileSync(path.join(workDir, 'llm-wiki', 'wiki', 'page.md'), 'wiki')
    fs.writeFileSync(path.join(workDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const wikiPage = await importRawFromWorkDir(workDir, wikiConfig, 'llm-wiki/wiki/page.md')
    expect(wikiPage.ok).toBe(false)

    const binary = await importRawFromWorkDir(workDir, wikiConfig, 'image.png')
    expect(binary.ok).toBe(false)
    if (!binary.ok) expect(binary.error).toContain('文本')
  })

  it('wikiImportFileTreeChange only notifies when a new raw file is copied', async () => {
    expect(wikiImportFileTreeChange({ ok: true, rawRelPath: 'llm-wiki/raw/a.md', copied: true })).toEqual({
      kind: 'paths',
      relPaths: ['llm-wiki/raw/a.md']
    })
    expect(wikiImportFileTreeChange({ ok: true, rawRelPath: 'llm-wiki/raw/a.md', copied: false })).toBeNull()
    expect(wikiImportFileTreeChange({ ok: false, error: 'fail' })).toBeNull()
  })
})
