import { describe, expect, it } from 'vitest'
import { assertSafeToolInput, toolErrMissingPath } from './toolInputGuards'
import { sanitizeToolErrorString } from './tools/toolUserErrors'

describe('assertSafeToolInput', () => {
  it('accepts valid read_file path', () => {
    expect(() => assertSafeToolInput('read_file', { path: 'src/a.ts' })).not.toThrow()
  })

  it('accepts read_file offset and limit', () => {
    expect(() => assertSafeToolInput('read_file', { path: 'a.ts', offset: 1, limit: 50 })).not.toThrow()
  })

  it('rejects read_file limit out of range', () => {
    expect(() => assertSafeToolInput('read_file', { path: 'a.ts', limit: 0 })).toThrow(/limit/)
    expect(() => assertSafeToolInput('read_file', { path: 'a.ts', limit: 99999 })).toThrow(/limit/)
  })

  it('accepts valid read_file tail', () => {
    expect(() => assertSafeToolInput('read_file', { path: 'a.ts', tail: 50 })).not.toThrow()
  })

  it('rejects read_file when tail is used with offset', () => {
    expect(() => assertSafeToolInput('read_file', { path: 'a.ts', tail: 10, offset: 1 })).toThrow(
      /tail 不能与 offset\/limit 同时使用/
    )
  })

  it('rejects read_file when tail is used with limit', () => {
    expect(() => assertSafeToolInput('read_file', { path: 'a.ts', tail: 10, limit: 5 })).toThrow(
      /tail 不能与 offset\/limit 同时使用/
    )
  })

  it('rejects read_file negative offset', () => {
    expect(() => assertSafeToolInput('read_file', { path: 'a.ts', offset: -1 })).toThrow(/offset/)
  })

  it('rejects read_file tail out of range', () => {
    expect(() => assertSafeToolInput('read_file', { path: 'a.ts', tail: 2001 })).toThrow(/tail/)
    expect(() => assertSafeToolInput('read_file', { path: 'a.ts', tail: 0 })).toThrow(/tail/)
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

  it('accepts valid run_shell command', () => {
    expect(() =>
      assertSafeToolInput('run_shell', { command: 'git status', description: 'check status' })
    ).not.toThrow()
  })

  it('rejects run_shell without command', () => {
    expect(() => assertSafeToolInput('run_shell', {})).toThrow(/command/)
  })

  it('rejects run_shell command too long', () => {
    expect(() => assertSafeToolInput('run_shell', { command: 'x'.repeat(8193) })).toThrow(/command/)
  })

  it('rejects run_shell timeout out of range', () => {
    expect(() => assertSafeToolInput('run_shell', { command: 'echo', timeout: 0 })).toThrow(/timeout/)
  })
})

describe('assertSafeToolInput - path field aliases', () => {
  it('accepts read_file with filePath', () => {
    expect(() => assertSafeToolInput('read_file', { filePath: 'src/a.ts' })).not.toThrow()
  })

  it('accepts read_file with file_path', () => {
    expect(() => assertSafeToolInput('read_file', { file_path: 'src/a.ts' })).not.toThrow()
  })

  it('rejects read_file with no path-like field and hints the correct name', () => {
    expect(() => assertSafeToolInput('read_file', { offset: 1, limit: 10 })).toThrow(
      /缺少必填参数 path.*请勿使用 filePath 或 file_path/
    )
  })

  it('rejects read_file alias too long', () => {
    expect(() => assertSafeToolInput('read_file', { filePath: 'x'.repeat(8193) })).toThrow(/过长/)
  })

  it('accepts list_directory with filePath', () => {
    expect(() => assertSafeToolInput('list_directory', { filePath: 'src' })).not.toThrow()
  })

  it('accepts list_directory with no path (still optional)', () => {
    expect(() => assertSafeToolInput('list_directory', {})).not.toThrow()
  })

  it('accepts grep with file_path', () => {
    expect(() => assertSafeToolInput('grep', { pattern: 'x', file_path: 'src' })).not.toThrow()
  })

  it('accepts edit_file with filePath', () => {
    expect(() =>
      assertSafeToolInput('edit_file', { filePath: 'a.txt', old_string: 'a', new_string: 'b' })
    ).not.toThrow()
  })

  it('accepts write_file with file_path', () => {
    expect(() =>
      assertSafeToolInput('write_file', { file_path: 'a.txt', content: 'hi' })
    ).not.toThrow()
  })

  it('rejects edit_file with no path-like field and hints the correct name', () => {
    expect(() =>
      assertSafeToolInput('edit_file', { old_string: 'a', new_string: 'b' })
    ).toThrow(/缺少必填参数 path.*请勿使用 filePath 或 file_path/)
  })

  it('rejects write_file with no path-like field and hints the correct name', () => {
    expect(() => assertSafeToolInput('write_file', { content: 'hi' })).toThrow(
      /缺少必填参数 path.*请勿使用 filePath 或 file_path/
    )
  })
})

describe('toolErrMissingPath hint survives sanitizeToolErrorString', () => {
  const fileTools = ['read_file', 'edit_file', 'write_file'] as const
  for (const toolName of fileTools) {
    it(`${toolName} missing-path hint reaches model after sanitize`, () => {
      const sanitized = sanitizeToolErrorString(toolErrMissingPath(toolName), toolName)
      // 不得回落到 defaultForTool（如 read_file 的「读取文件失败，请检查路径后重试」）
      expect(sanitized).toMatch(/缺少必填参数 path/)
      expect(sanitized).toMatch(/请勿使用 filePath 或 file_path/)
    })
  }
})
