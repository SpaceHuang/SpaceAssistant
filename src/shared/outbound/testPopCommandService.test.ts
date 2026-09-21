import { describe, it, expect } from 'vitest'
import { parseTestPopCommand } from './testPopCommandService'

describe('parseTestPopCommand', () => {
  it('should return chat type for non-command text', () => {
    const result = parseTestPopCommand('hello world', { isDev: true })
    expect(result).toEqual({ type: 'chat', text: 'hello world' })
  })

  it('should return command type with help hint', () => {
    const result = parseTestPopCommand('/test-pop help', { isDev: true })
    expect(result.type).toBe('command')
    if (result.type === 'command') {
      expect(result.hint).toContain('/test-pop')
    }
  })

  it('should return dev-only hint in production', () => {
    const result = parseTestPopCommand('/test-pop', { isDev: false })
    expect(result).toEqual({ type: 'command', hint: '[Dev] /test-pop 仅在开发模式下可用' })
  })

  it('should return run type for /test-pop in dev mode', () => {
    const result = parseTestPopCommand('/test-pop', { isDev: true })
    expect(result).toEqual({ type: 'run' })
  })
})
