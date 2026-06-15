import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppDatabase } from './database'

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en-US') }
}))

vi.mock('./appIpc', () => ({
  readAppLocale: vi.fn(() => 'zh-CN' as const)
}))

import { app } from 'electron'
import { readAppLocale } from './appIpc'
import { buildFinalSystemPrompt, resolveRequestLocale } from './llmSystemPrompt'

function mockDb(): AppDatabase {
  return { data: { config: {}, sessions: [], messages: [] } } as unknown as AppDatabase
}

describe('resolveRequestLocale', () => {
  beforeEach(() => {
    vi.mocked(readAppLocale).mockReturnValue('zh-CN')
    vi.mocked(app.getLocale).mockReturnValue('en-US')
  })

  it('R1: payload en-US takes priority over db', () => {
    expect(resolveRequestLocale('en-US', mockDb())).toBe('en-US')
  })

  it('R2: undefined payload falls back to readAppLocale', () => {
    vi.mocked(readAppLocale).mockReturnValue('en-US')
    expect(resolveRequestLocale(undefined, mockDb())).toBe('en-US')
    expect(readAppLocale).toHaveBeenCalled()
  })

  it('R3: invalid payload falls back to db without throwing', () => {
    vi.mocked(readAppLocale).mockReturnValue('zh-CN')
    expect(resolveRequestLocale('invalid', mockDb())).toBe('zh-CN')
  })

  it('R4: no db and invalid payload falls back to detectLocaleFromSystem', () => {
    vi.mocked(app.getLocale).mockReturnValue('en-US')
    expect(resolveRequestLocale(undefined, undefined)).toBe('en-US')
  })
})

describe('buildFinalSystemPrompt', () => {
  it('R5: zh-CN without memory includes Chinese locale hint, no project_memory', () => {
    const result = buildFinalSystemPrompt({
      locale: 'zh-CN',
      memoryEnabled: false,
      memoryContent: '# mem',
      system: 'base'
    })
    expect(result).toContain('Simplified Chinese')
    expect(result).not.toContain('<project_memory>')
    expect(result).toContain('base')
  })

  it('R6: memory block before locale hint when memory enabled', () => {
    const result = buildFinalSystemPrompt({
      locale: 'en-US',
      memoryEnabled: true,
      memoryContent: 'memory text',
      system: 'base'
    })!
    const memIdx = result.indexOf('<project_memory>')
    const localeIdx = result.indexOf('<ui_locale_preference>')
    expect(memIdx).toBeGreaterThan(-1)
    expect(localeIdx).toBeGreaterThan(memIdx)
    expect(result).toContain('English (en-US)')
  })

  it('R7: memory disabled still includes locale hint', () => {
    const result = buildFinalSystemPrompt({
      locale: 'zh-CN',
      memoryEnabled: false,
      memoryContent: '# mem',
      system: undefined
    })
    expect(result).toContain('<ui_locale_preference>')
    expect(result).not.toContain('<project_memory>')
  })

  it('R8: locale change between calls updates hint language', () => {
    const first = buildFinalSystemPrompt({
      locale: 'zh-CN',
      memoryEnabled: false,
      memoryContent: null,
      system: 'base'
    })!
    const second = buildFinalSystemPrompt({
      locale: 'en-US',
      memoryEnabled: false,
      memoryContent: null,
      system: 'base'
    })!
    expect(first).toContain('Simplified Chinese')
    expect(second).toContain('English (en-US)')
  })
})
