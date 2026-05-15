import { describe, expect, it } from 'vitest'
import { assertSafeToolInput } from './toolInputGuards'

describe('assertSafeToolInput', () => {
  it('accepts valid read_file path', () => {
    expect(() => assertSafeToolInput('read_file', { path: 'src/a.ts' })).not.toThrow()
  })

  it('rejects path with NUL', () => {
    expect(() => assertSafeToolInput('read_file', { path: 'a\0b' })).toThrow(/空字节/)
  })

  it('rejects grep without pattern', () => {
    expect(() => assertSafeToolInput('grep', {})).toThrow(/pattern/)
  })

  it('rejects head_limit out of range', () => {
    expect(() => assertSafeToolInput('grep', { pattern: 'x', head_limit: -1 })).toThrow(/head_limit/)
  })

  it('rejects run_script timeout too large', () => {
    expect(() => assertSafeToolInput('run_script', { code: 'print(1)', timeout: 999_999_999 })).toThrow(/timeout/)
  })

  it('rejects write_file missing content', () => {
    expect(() => assertSafeToolInput('write_file', { path: 'a.txt' })).toThrow(/content/)
  })
})
