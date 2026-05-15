import { describe, expect, it } from 'vitest'
import path from 'path'
import os from 'os'
import { resolveSafePath } from './pathSecurity'

describe('resolveSafePath', () => {
  const base = path.join(os.tmpdir(), 'spaceassistant-path-test')

  it('resolves normal relative paths', () => {
    expect(resolveSafePath(base, 'a/b')).toBe(path.join(base, 'a', 'b'))
  })

  it('rejects traversal', () => {
    expect(() => resolveSafePath(base, '..\\secret')).toThrow()
  })
})
