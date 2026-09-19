import { describe, expect, it, vi } from 'vitest'
import { classifyOutboundMessageWithDeps } from './chatOutboundClassifier'
import { DEFAULT_WIKI_CONFIG } from '../../shared/domainTypes'
import type { SkillDefinition } from '../../shared/domainTypes'

function makeSkill(name: string, scope: SkillDefinition['scope']): SkillDefinition {
  return {
    meta: { name, description: '演示技能', triggers: [], version: '1.0.0', author: 'test' },
    content: '',
    scope,
    directoryPath: '',
    filePath: '',
    lastModified: 0
  }
}

function makeDeps(overrides: Partial<Parameters<typeof classifyOutboundMessageWithDeps>[2]> = {}) {
  return {
    isDev: overrides.isDev ?? true,
    listSkills: overrides.listSkills ?? vi.fn().mockResolvedValue([]),
    getSkill: overrides.getSkill ?? vi.fn().mockResolvedValue(null),
    wikiInit: overrides.wikiInit ?? vi.fn().mockResolvedValue({ ok: true, rootPath: 'llm-wiki', skillInstalled: true }),
    wikiStatus: overrides.wikiStatus ??
      vi.fn().mockResolvedValue({
        enabled: true,
        rootPath: 'llm-wiki',
        initialized: true,
        pageCount: 2,
        rawCount: 0
      }),
    wikiImportRaw: overrides.wikiImportRaw ??
      vi.fn().mockImplementation(async ({ srcRelPath }: { srcRelPath: string }) => ({
        ok: true,
        rawRelPath: srcRelPath,
        copied: false
      }))
  }
}

const ctx = {
  wikiConfig: { ...DEFAULT_WIKI_CONFIG, enabled: true },
  sessionSkillsState: { manualActivated: [], manualDisabled: [] }
}

describe('classifyOutboundMessageWithDeps', () => {
  it('empty text classifies as chat-run', async () => {
    expect(await classifyOutboundMessageWithDeps('', ctx, makeDeps())).toBe('chat-run')
    expect(await classifyOutboundMessageWithDeps('   ', ctx, makeDeps())).toBe('chat-run')
  })

  it('plain text classifies as chat-run', async () => {
    expect(await classifyOutboundMessageWithDeps('你好世界', ctx, makeDeps())).toBe('chat-run')
  })

  it('/test-cards help is immediate-command', async () => {
    expect(await classifyOutboundMessageWithDeps('/test-cards help', ctx, makeDeps())).toBe('immediate-command')
  })

  it('/test-cards run in dev goes chat-run', async () => {
    expect(await classifyOutboundMessageWithDeps('/test-cards', ctx, makeDeps())).toBe('chat-run')
  })

  it('/test-cards run outside dev is immediate-command (dev-only hint)', async () => {
    expect(await classifyOutboundMessageWithDeps('/test-cards', ctx, makeDeps({ isDev: false }))).toBe(
      'immediate-command'
    )
  })

  it('/test-pop is immediate-command (render-local execution)', async () => {
    expect(await classifyOutboundMessageWithDeps('/test-pop', ctx, makeDeps())).toBe('immediate-command')
  })

  it('wiki command-hints are immediate-command', async () => {
    expect(await classifyOutboundMessageWithDeps('/wiki help', ctx, makeDeps())).toBe('immediate-command')
    expect(await classifyOutboundMessageWithDeps('/wiki init', ctx, makeDeps())).toBe('immediate-command')
  })

  it('wiki run-modes go chat-run', async () => {
    expect(await classifyOutboundMessageWithDeps('/wiki query 如何重构', ctx, makeDeps())).toBe('chat-run')
    expect(await classifyOutboundMessageWithDeps('/wiki ingest --all', ctx, makeDeps())).toBe('chat-run')
  })

  it('skill commands are immediate-command', async () => {
    const deps = makeDeps({ listSkills: vi.fn().mockResolvedValue([makeSkill('demo', 'project')]) })
    expect(await classifyOutboundMessageWithDeps('/skill list', ctx, deps)).toBe('immediate-command')
    expect(await classifyOutboundMessageWithDeps('/skill status', ctx, makeDeps())).toBe('immediate-command')
  })
})
