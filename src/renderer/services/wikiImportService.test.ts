import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  canShowCollectToWiki,
  collectToWiki,
  formatCollectToWikiToast,
  triggerWikiIngest
} from './wikiImportService'

describe('wikiImportService', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        wikiStatus: vi.fn().mockResolvedValue({
          enabled: true,
          rootPath: 'llm-wiki',
          initialized: true,
          pageCount: 1,
          rawCount: 0
        }),
        wikiImportRaw: vi.fn().mockResolvedValue({
          ok: true,
          rawRelPath: 'llm-wiki/raw/note.md',
          copied: true
        })
      },
      dispatchEvent: vi.fn()
    })
  })

  it('detects collectable files', () => {
    expect(canShowCollectToWiki('docs/a.md', 'llm-wiki', false, true)).toBe(true)
    expect(canShowCollectToWiki('llm-wiki/wiki/a.md', 'llm-wiki', false, true)).toBe(false)
    expect(canShowCollectToWiki('docs/a.md', 'llm-wiki', false, false)).toBe(false)
  })

  it('formats toast for copied and existing raw', () => {
    expect(formatCollectToWikiToast({ ok: true, rawRelPath: 'llm-wiki/raw/a.md', copied: true })).toContain('已导入 raw')
    expect(formatCollectToWikiToast({ ok: true, rawRelPath: 'llm-wiki/raw/a.md', copied: false })).toContain('Ingest 已开始')
  })

  it('collects external file and triggers ingest', async () => {
    const onSuccess = vi.fn()
    const result = await collectToWiki('docs/note.md', {
      wikiEnabled: true,
      sessionId: 's1',
      onSuccess
    })
    expect(result?.ok).toBe(true)
    expect(window.api.wikiImportRaw).toHaveBeenCalledWith({ srcRelPath: 'docs/note.md' })
    expect(onSuccess).toHaveBeenCalled()
    triggerWikiIngest('llm-wiki/raw/note.md')
    expect(window.dispatchEvent).toHaveBeenCalled()
  })

  it('requires session', async () => {
    const onMissingSession = vi.fn()
    const result = await collectToWiki('docs/note.md', {
      wikiEnabled: true,
      sessionId: null,
      onMissingSession
    })
    expect(result).toBeNull()
    expect(onMissingSession).toHaveBeenCalled()
  })
})
