import { describe, expect, it, beforeEach } from 'vitest'
import {
  checkWritePathConflict,
  claimWritePath,
  releaseWritePath,
  releaseAllWritePathsForSession,
  clearWritePathOwners,
  normalizeToolRelPath
} from './toolWriteConflict'

describe('toolWriteConflict', () => {
  beforeEach(() => {
    clearWritePathOwners()
  })

  it('normalizes paths', () => {
    expect(normalizeToolRelPath('.\\foo\\bar.ts')).toBe('foo/bar.ts')
  })

  it('detects conflict from another session', () => {
    claimWritePath('s1', 'src/a.ts')
    expect(checkWritePathConflict('s2', 'src/a.ts')).toMatch(/其他会话/)
    expect(checkWritePathConflict('s1', 'src/a.ts')).toBeNull()
  })

  it('releases path after write', () => {
    claimWritePath('s1', 'src/a.ts')
    releaseWritePath('s1', 'src/a.ts')
    expect(checkWritePathConflict('s2', 'src/a.ts')).toBeNull()
  })

  it('releaseAllWritePathsForSession clears session claims', () => {
    claimWritePath('s1', 'a.ts')
    claimWritePath('s1', 'b.ts')
    claimWritePath('s2', 'c.ts')
    releaseAllWritePathsForSession('s1')
    expect(checkWritePathConflict('s2', 'a.ts')).toBeNull()
    expect(checkWritePathConflict('s1', 'c.ts')).toMatch(/其他会话/)
  })
})
