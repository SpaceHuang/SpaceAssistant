import { describe, expect, it } from 'vitest'
import { parseTestCardsCommand } from './testCardsCommandService'

describe('parseTestCardsCommand', () => {
  it('returns chat for non-command text', () => {
    expect(parseTestCardsCommand('hello', { isDev: true })).toEqual({ type: 'chat', text: 'hello' })
  })

  it('returns help command', () => {
    const result = parseTestCardsCommand('/test-cards help', { isDev: true })
    expect(result.type).toBe('command')
    if (result.type === 'command') {
      expect(result.hint).toContain('/test-cards')
      expect(result.hint).toContain('开发模式')
    }
  })

  it('returns dev-only hint in production', () => {
    const result = parseTestCardsCommand('/test-cards', { isDev: false })
    expect(result).toEqual({ type: 'command', hint: '[Dev] /test-cards 仅在开发模式下可用' })
  })

  it('returns run in development', () => {
    expect(parseTestCardsCommand('/test-cards', { isDev: true })).toEqual({ type: 'run' })
  })
})
