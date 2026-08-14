import { describe, expect, it } from 'vitest'
import { PATH_FIELD_ALIASES, extractPathField } from './toolPathField'

describe('extractPathField', () => {
  it('returns path when present', () => {
    expect(extractPathField({ path: 'src/a.ts' })).toBe('src/a.ts')
  })

  it('falls back to filePath', () => {
    expect(extractPathField({ filePath: 'src/a.ts' })).toBe('src/a.ts')
  })

  it('falls back to file_path', () => {
    expect(extractPathField({ file_path: 'src/a.ts' })).toBe('src/a.ts')
  })

  it('prefers path over aliases when multiple present', () => {
    expect(extractPathField({ path: 'p', filePath: 'fp', file_path: 'fp2' })).toBe('p')
  })

  it('prefers filePath over file_path', () => {
    expect(extractPathField({ filePath: 'fp', file_path: 'fp2' })).toBe('fp')
  })

  it('returns undefined when none present', () => {
    expect(extractPathField({})).toBeUndefined()
  })

  it('skips non-string values and continues to next alias', () => {
    expect(extractPathField({ path: 123, filePath: 'src/a.ts' })).toBe('src/a.ts')
  })

  it('treats empty string as missing', () => {
    expect(extractPathField({ path: '' })).toBeUndefined()
  })

  it('treats whitespace-only string as missing', () => {
    expect(extractPathField({ path: '   ' })).toBeUndefined()
  })

  it('exposes alias order for documentation', () => {
    expect([...PATH_FIELD_ALIASES]).toEqual(['path', 'filePath', 'file_path'])
  })
})
