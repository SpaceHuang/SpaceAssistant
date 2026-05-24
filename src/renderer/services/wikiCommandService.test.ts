import { describe, expect, it, vi, beforeEach } from 'vitest'
import { parseWikiCommand, isWikiPathLink } from './wikiCommandService'
import { DEFAULT_WIKI_CONFIG } from '../../shared/domainTypes'

describe('wikiCommandService', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        wikiInit: vi.fn().mockResolvedValue({ ok: true, rootPath: 'llm-wiki', skillInstalled: true }),
        wikiStatus: vi.fn().mockResolvedValue({
          enabled: true,
          rootPath: 'llm-wiki',
          initialized: true,
          pageCount: 2,
          rawCount: 0
        }),
        wikiImportRaw: vi.fn().mockImplementation(async ({ srcRelPath }: { srcRelPath: string }) => {
          if (srcRelPath.startsWith('llm-wiki/raw/')) {
            return { ok: true, rawRelPath: srcRelPath, copied: false }
          }
          return { ok: true, rawRelPath: `llm-wiki/raw/${srcRelPath.split('/').pop()}`, copied: true }
        })
      }
    })
  })

  it('returns chat for normal messages', async () => {
    const r = await parseWikiCommand('hello', DEFAULT_WIKI_CONFIG, { manualActivated: [], manualDisabled: [] })
    expect(r.type).toBe('chat')
  })

  it('shows help', async () => {
    const enabled = { ...DEFAULT_WIKI_CONFIG, enabled: true }
    const r = await parseWikiCommand('/wiki help', enabled, { manualActivated: [], manualDisabled: [] })
    expect(r.type).toBe('command')
    if (r.type === 'command') expect(r.hint).toContain('ingest')
  })

  it('runs ingest command for raw path', async () => {
    const enabled = { ...DEFAULT_WIKI_CONFIG, enabled: true }
    const r = await parseWikiCommand('/wiki ingest llm-wiki/raw/test.md', enabled, { manualActivated: [], manualDisabled: [] })
    expect(r.type).toBe('run')
    if (r.type === 'run') {
      expect(r.skillsState.manualActivated).toContain('llm-wiki')
      expect(r.text).toContain('llm-wiki/raw/test.md')
      expect(r.hint).toContain('Ingest 已开始')
    }
  })

  it('imports external path before ingest', async () => {
    const enabled = { ...DEFAULT_WIKI_CONFIG, enabled: true }
    const r = await parseWikiCommand('/wiki ingest docs/note.md', enabled, { manualActivated: [], manualDisabled: [] })
    expect(window.api.wikiImportRaw).toHaveBeenCalledWith({ srcRelPath: 'docs/note.md' })
    expect(r.type).toBe('run')
    if (r.type === 'run') {
      expect(r.text).toContain('llm-wiki/raw/note.md')
      expect(r.hint).toContain('已导入 raw')
    }
  })

  it.each(['摄取', '提取'])('runs ingest via Chinese alias %s', async (alias) => {
    const enabled = { ...DEFAULT_WIKI_CONFIG, enabled: true }
    const r = await parseWikiCommand(`/wiki ${alias} raw/article.md`, enabled, { manualActivated: [], manualDisabled: [] })
    expect(r.type).toBe('run')
    if (r.type === 'run') {
      expect(r.text).toContain('raw/article.md')
      expect(r.hint).toContain('raw/article.md')
    }
  })

  it('detects wiki path links', () => {
    expect(isWikiPathLink('llm-wiki/wiki/index.md')).toBe('llm-wiki/wiki/index.md')
    expect(isWikiPathLink('wiki/entities/foo.md')).toBe('llm-wiki/wiki/entities/foo.md')
    expect(isWikiPathLink('https://example.com')).toBeNull()
  })
})
