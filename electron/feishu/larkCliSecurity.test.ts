import { describe, expect, it } from 'vitest'
import { assertSafeLarkCliArgs, isLarkCliWriteOperation } from './larkCliSecurity'

describe('larkCliSecurity', () => {
  it('rejects shell metacharacters', () => {
    expect(() => assertSafeLarkCliArgs(['message', 'send', ';', 'rm'])).toThrow()
  })

  it('rejects event subcommand', () => {
    expect(() => assertSafeLarkCliArgs(['event', 'subscribe'])).toThrow(/event/)
  })

  it('detects write operations', () => {
    expect(isLarkCliWriteOperation(['message', 'send'])).toBe(true)
    expect(isLarkCliWriteOperation(['message', 'search'])).toBe(false)
    expect(isLarkCliWriteOperation(['api', 'POST', '/x'])).toBe(true)
    expect(isLarkCliWriteOperation(['api', 'GET', '/x'])).toBe(false)
  })

  it('rejects non-string argv elements with controlled error', () => {
    expect(() => assertSafeLarkCliArgs(['doc', 1])).toThrow(/string/)
    expect(() => assertSafeLarkCliArgs([1])).toThrow(/string/)
  })
})
