export interface PathLease {
  release(): void
}

export interface PathMultiLease extends PathLease {
  identities: string[]
}

type LeaseState = { uses: number; write: boolean; deleting: boolean }

/** In-process lease state for path identities; callers must release in finally blocks. */
export class PathLeaseRegistry {
  private readonly states = new Map<string, LeaseState>()

  acquireUse(identity: string): PathLease {
    const state = this.state(identity)
    if (state.write || state.deleting) throw new Error('Path lease is unavailable')
    state.uses += 1
    return this.lease(identity, () => { state.uses -= 1 })
  }

  acquireWrite(identity: string): PathLease {
    const state = this.state(identity)
    if (state.uses || state.write || state.deleting) throw new Error('Path lease is unavailable')
    state.write = true
    return this.lease(identity, () => { state.write = false })
  }

  claimDelete(identity: string): PathLease {
    const state = this.state(identity)
    if (state.uses || state.write || state.deleting) throw new Error('Path lease is unavailable')
    state.deleting = true
    return this.lease(identity, () => { state.deleting = false })
  }

  acquireWrites(identities: readonly string[]): PathMultiLease {
    const ordered = [...new Set(identities)].sort()
    const leases: PathLease[] = []
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

  private lease(identity: string, onRelease: () => void): PathLease {
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
