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

  it('rejects edit_file missing path', () => {
    expect(() => assertSafeToolInput('edit_file', { old_string: 'a', new_string: 'b' })).toThrow(/缺少必填参数 path/)
  })

  it('rejects write_file missing path', () => {
    expect(() => assertSafeToolInput('write_file', { content: 'hello' })).toThrow(/缺少必填参数 path/)
  })

  it('rejects edit_file with blank path', () => {
    expect(() => assertSafeToolInput('edit_file', { path: '   ', old_string: 'a', new_string: 'b' })).toThrow(/缺少必填参数 path/)
  })

  it('accepts valid browser navigate', () => {
    expect(() =>
      assertSafeToolInput('browser', { action: 'navigate', mode: 'open', url: 'https://example.com' })
    ).not.toThrow()
  })

  it('accepts valid browser extract', () => {
    expect(() => assertSafeToolInput('browser', { action: 'extract', instruction: 'get content' })).not.toThrow()
  })

  it('accepts browser observe without instruction', () => {
    expect(() => assertSafeToolInput('browser', { action: 'observe' })).not.toThrow()
  })

  it('rejects browser without action', () => {
    expect(() => assertSafeToolInput('browser', {})).toThrow(/缺少有效的 action/)
  })

  it('rejects browser invalid action', () => {
    expect(() => assertSafeToolInput('browser', { action: 'fly' })).toThrow(/缺少有效的 action/)
  })

  it('rejects navigate open without url', () => {
    expect(() => assertSafeToolInput('browser', { action: 'navigate', mode: 'open' })).toThrow(/url/)
  })

  it('rejects extract without instruction', () => {
    expect(() => assertSafeToolInput('browser', { action: 'extract' })).toThrow(/instruction/)
  })

  it('rejects url too long', () => {
    expect(() =>
      assertSafeToolInput('browser', {
        action: 'navigate',
        mode: 'open',
        url: 'x'.repeat(4097)
      })
    ).toThrow(/url/)
  })
})
