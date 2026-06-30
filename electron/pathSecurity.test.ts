import { describe, expect, it } from 'vitest'
import path from 'path'
import { normalizeRelPathInput, resolveSafePath } from './pathSecurity'

describe('pathSecurity', () => {
  it('normalizeRelPathInput converts backslashes', () => {
    expect(normalizeRelPathInput('项目\\上传者\\草稿')).toBe('项目/上传者/草稿')
  })

  it('resolveSafePath accepts normalized relative paths on Windows', () => {
    const base = path.resolve('/fake/workdir')
    const resolved = resolveSafePath(base, '项目/上传者/草稿')
    expect(resolved).toBe(path.resolve(base, '项目/上传者/草稿'))
  })
})
