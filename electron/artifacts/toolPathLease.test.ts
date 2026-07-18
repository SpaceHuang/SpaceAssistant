import { beforeEach, describe, expect, it } from 'vitest'
import {
  acquireToolWriteLease,
  checkToolWriteLeaseConflict,
  clearToolPathLeases,
  releaseAllToolPathLeasesForSession,
  getSharedArtifactPathLeaseRegistry
} from './toolPathLease'

describe('toolPathLease', () => {
  beforeEach(() => {
    clearToolPathLeases()
  })

  it('acquires an exclusive write lease and releases it in a finally-style flow', () => {
    const lease = acquireToolWriteLease('s1', 'src/a.ts')
    expect(checkToolWriteLeaseConflict('s2', 'src/a.ts')).toMatch(/占用/)
    expect(() => getSharedArtifactPathLeaseRegistry().acquireWrite('src/a.ts')).toThrow(/lease/i)

    lease.release()

    expect(checkToolWriteLeaseConflict('s2', 'src/a.ts')).toBeNull()
    expect(() => getSharedArtifactPathLeaseRegistry().acquireWrite('src/a.ts')).not.toThrow()
  })

  it('releases every outstanding lease for a session', () => {
    acquireToolWriteLease('s1', 'a.ts')
    acquireToolWriteLease('s1', 'b.ts')
    acquireToolWriteLease('s2', 'c.ts')
    releaseAllToolPathLeasesForSession('s1')
    expect(checkToolWriteLeaseConflict('s2', 'a.ts')).toBeNull()
    expect(checkToolWriteLeaseConflict('s1', 'c.ts')).toMatch(/占用/)
  })
})
