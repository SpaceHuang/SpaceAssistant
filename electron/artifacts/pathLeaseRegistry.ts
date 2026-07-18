export interface ArtifactPathLease {
  release(): void
}

export interface ArtifactPathMultiLease extends ArtifactPathLease {
  identities: string[]
}

type LeaseState = { uses: number; write: boolean; deleting: boolean }

/** In-process lease state for artifact identities; callers must release in finally blocks. */
export class ArtifactPathLeaseRegistry {
  private readonly states = new Map<string, LeaseState>()

  acquireUse(identity: string): ArtifactPathLease {
    const state = this.state(identity)
    if (state.write || state.deleting) throw new Error('Artifact path lease is unavailable')
    state.uses += 1
    return this.lease(identity, () => { state.uses -= 1 })
  }

  acquireWrite(identity: string): ArtifactPathLease {
    const state = this.state(identity)
    if (state.uses || state.write || state.deleting) throw new Error('Artifact path lease is unavailable')
    state.write = true
    return this.lease(identity, () => { state.write = false })
  }

  claimDelete(identity: string): ArtifactPathLease {
    const state = this.state(identity)
    if (state.uses || state.write || state.deleting) throw new Error('Artifact path lease is unavailable')
    state.deleting = true
    return this.lease(identity, () => undefined)
  }

  acquireWrites(identities: readonly string[]): ArtifactPathMultiLease {
    const ordered = [...new Set(identities)].sort()
    const leases: ArtifactPathLease[] = []
    try {
      for (const identity of ordered) leases.push(this.acquireWrite(identity))
    } catch (error) {
      for (const lease of leases.reverse()) lease.release()
      throw error
    }
    let released = false
    return {
      identities: ordered,
      release: () => {
        if (released) return
        released = true
        for (const lease of leases.reverse()) lease.release()
      }
    }
  }

  private state(identity: string): LeaseState {
    let state = this.states.get(identity)
    if (!state) {
      state = { uses: 0, write: false, deleting: false }
      this.states.set(identity, state)
    }
    return state
  }

  private lease(identity: string, onRelease: () => void): ArtifactPathLease {
    let released = false
    return { release: () => {
      if (released) return
      released = true
      onRelease()
      const state = this.states.get(identity)
      if (state && !state.uses && !state.write && !state.deleting) this.states.delete(identity)
    } }
  }
}
