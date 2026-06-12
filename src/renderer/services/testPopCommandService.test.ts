import { describe, it, expect } from 'vitest'
import { parseTestPopCommand } from './testPopCommandService'

describe('parseTestPopCommand', () => {
  it('should return chat type for non-command text', () => {
    const result = parseTestPopCommand('hello world')
    expect(result).toEqual({ type: 'chat', text: 'hello world' })
  })

  it('should return command type with help hint', () => {
    const result = parseTestPopCommand('/test-pop help')
    expect(result.type).toBe('command')
    if (result.type === 'command') {
      expect(result.hint).toContain('/test-pop')
    }
  })

  it('should return run type for /test-pop in dev mode', () => {
    const result = parseTestPopCommand('/test-pop')
    expect(result).toEqual({ type: 'run' })
  })
})
