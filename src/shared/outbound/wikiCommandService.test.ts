import { describe, expect, it, vi } from 'vitest'
import { parseWikiCommand, isWikiPathLink } from './wikiCommandService'

function makeDeps() {
  return {
    wikiInit: vi.fn().mockResolvedValue({ ok: true, rootPath: 'llm-wiki', skillInstalled: true }),
    wikiStatus: vi.fn().mockResolvedValue({
      rootPath: 'llm-wiki',
      initialized: true,
      pageCount: 2,
      rawCount: 0
    }),
    wikiImportRaw: vi.fn().mockImplementation(async ({ srcRelPath }: { srcRelPath: string }) => {
      if (srcRelPath.startsWith('llm-wiki/raw/')) {
        return { ok: true, rawRelPath: srcRelPath, copied: false, sourceId: 'source-existing', sourceRevision: 1 }
      }
      return { ok: true, rawRelPath: `llm-wiki/raw/${srcRelPath.split('/').pop()}`, copied: true, sourceId: 'source-imported', sourceRevision: 1 }
    })
  }
}

describe('wikiCommandService', () => {
  it('returns chat for normal messages', async () => {
    const r = await parseWikiCommand(
      'hello',
      { manualActivated: [], manualDisabled: [] },
      makeDeps()
    )
    expect(r.type).toBe('chat')
  })

  it('shows help', async () => {
    const r = await parseWikiCommand(
      '/wiki help',
      { manualActivated: [], manualDisabled: [] },
      makeDeps()
    )
    expect(r.type).toBe('command')
    if (r.type === 'command') expect(r.hint).toContain('ingest')
  })

  it('runs init via injected wikiInit port', async () => {
    const deps = makeDeps()
    const r = await parseWikiCommand('/wiki init', { manualActivated: [], manualDisabled: [] }, deps)
    expect(r.type).toBe('command')
    expect(deps.wikiInit).toHaveBeenCalledWith({ installSkill: true })
    if (r.type === 'command') expect(r.hint).toContain('已初始化')
  })

  it('runs ingest command for raw path', async () => {
    const r = await parseWikiCommand(
      '/wiki ingest llm-wiki/raw/test.md',
      { manualActivated: [], manualDisabled: [] },
      makeDeps()
    )
    expect(r.type).toBe('run')
    if (r.type === 'run') {
      expect(r.skillsState.manualActivated).toContain('llm-wiki')
      expect(r.text).toContain('sourceId=source-existing')
      expect(r.hint).toContain('Ingest 已开始')
    }
  })

  it('imports external path before ingest', async () => {
    const deps = makeDeps()
    const r = await parseWikiCommand(
      '/wiki ingest docs/note.md',
      { manualActivated: [], manualDisabled: [] },
      deps
    )
    expect(deps.wikiImportRaw).toHaveBeenCalledWith({ srcRelPath: 'docs/note.md' })
    expect(r.type).toBe('run')
    if (r.type === 'run') {
      expect(r.text).toContain('sourceId=source-imported')
      expect(r.hint).toContain('已绑定知识来源')
    }
  })

  it('host imports every selected source for --all and passes only bound source ids to the agent', async () => {
    const deps = {
      ...makeDeps(),
      wikiImportAllRaw: vi.fn().mockResolvedValue({ ok: true as const, sources: [
        { sourceId: 'source-a', sourceRevision: 1, displayName: 'a.md' },
        { sourceId: 'source-b', sourceRevision: 2, displayName: 'b.txt' }
      ] })
    }
    const result = await parseWikiCommand('/wiki ingest --all', { manualActivated: [], manualDisabled: [] }, deps)
    expect(deps.wikiImportAllRaw).toHaveBeenCalledOnce()
    expect(result.type).toBe('run')
    if (result.type === 'run') {
      expect(result.text).toContain('sourceId=source-a')
      expect(result.text).toContain('sourceId=source-b')
      expect(result.text).not.toContain('llm-wiki/raw')
    }
  })

  it('does not ask the agent to enumerate files when the host bulk import port is unavailable', async () => {
    const result = await parseWikiCommand('/wiki ingest --all', { manualActivated: [], manualDisabled: [] }, makeDeps())
    expect(result.type).toBe('command')
    if (result.type === 'command') expect(result.hint).toContain('批量来源导入不可用')
  })

  it.each(['摄取', '提取'])('runs ingest via Chinese alias %s', async (alias) => {
    const r = await parseWikiCommand(
      `/wiki ${alias} raw/article.md`,
      { manualActivated: [], manualDisabled: [] },
      makeDeps()
    )
    expect(r.type).toBe('run')
    if (r.type === 'run') {
      expect(r.text).toContain('sourceId=source-imported')
      expect(r.hint).toContain('source-imported')
    }
  })

  it('detects wiki path links', () => {
    expect(isWikiPathLink('llm-wiki/wiki/index.md')).toBe('llm-wiki/wiki/index.md')
    expect(isWikiPathLink('wiki/entities/foo.md')).toBe('llm-wiki/wiki/entities/foo.md')
    expect(isWikiPathLink('https://example.com')).toBeNull()
  })
})
