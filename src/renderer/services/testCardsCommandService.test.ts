import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseTestCardsCommand } from './testCardsCommandService'

describe('parseTestCardsCommand', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns chat for non-command text', () => {
    expect(parseTestCardsCommand('hello')).toEqual({ type: 'chat', text: 'hello' })
  })

  it('returns help command', () => {
    const result = parseTestCardsCommand('/test-cards help')
    expect(result.type).toBe('command')
    if (result.type === 'command') {
      expect(result.hint).toContain('/test-cards')
      expect(result.hint).toContain('开发模式')
    }
  })

  it('returns dev-only hint in production', () => {
    vi.stubEnv('DEV', false)
    const result = parseTestCardsCommand('/test-cards')
    expect(result).toEqual({ type: 'command', hint: '[Dev] /test-cards 仅在开发模式下可用' })
  })

  it('returns run in development', () => {
    vi.stubEnv('DEV', true)
    expect(parseTestCardsCommand('/test-cards')).toEqual({ type: 'run' })
  })
})
