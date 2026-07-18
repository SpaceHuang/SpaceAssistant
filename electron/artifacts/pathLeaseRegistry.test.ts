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
})
