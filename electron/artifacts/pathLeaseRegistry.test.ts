import { describe, expect, it } from 'vitest'
import { ArtifactPathLeaseRegistry } from './pathLeaseRegistry'

describe('ArtifactPathLeaseRegistry', () => {
  it('shares use leases while write and delete remain exclusive', () => {
    const registry = new ArtifactPathLeaseRegistry()
    const first = registry.acquireUse('path-a')
    const second = registry.acquireUse('path-a')
    expect(() => registry.acquireWrite('path-a')).toThrow(/lease/i)
    first.release()
    second.release()

    const write = registry.acquireWrite('path-a')
    expect(() => registry.claimDelete('path-a')).toThrow(/lease/i)
    write.release()
    registry.claimDelete('path-a').release()
  })

  it('allows reacquisition after a finally-style release', () => {
    const registry = new ArtifactPathLeaseRegistry()
    const lease = registry.acquireWrite('path-a')
    lease.release()
    expect(() => registry.acquireWrite('path-a')).not.toThrow()
  })

  it('releases a delete tombstone after finally-style release so the path can be rewritten', () => {
    const registry = new ArtifactPathLeaseRegistry()
    const activeUse = registry.acquireUse('path-a')
    expect(() => registry.claimDelete('path-a')).toThrow(/lease/i)
    activeUse.release()
    registry.claimDelete('path-a').release()
    const useAgain = registry.acquireUse('path-a')
    useAgain.release()
    expect(() => registry.acquireWrite('path-a')).not.toThrow()
  })

  it('acquires multi-path writes in identity order and rolls back if any path is unavailable', () => {
    const registry = new ArtifactPathLeaseRegistry()
    expect(registry.acquireWrites(['path-b', 'path-a']).identities).toEqual(['path-a', 'path-b'])

    const blocked = new ArtifactPathLeaseRegistry()
    blocked.acquireWrite('path-b')
    expect(() => blocked.acquireWrites(['path-a', 'path-b'])).toThrow(/lease/i)
    expect(() => blocked.acquireWrite('path-a')).not.toThrow()
  })
})
