export type CapabilityLookup =
  | { state: 'known-authorized'; id: string }
  | { state: 'known-unauthorized'; id: string }
  | { state: 'unknown'; requestedId: string }

type InvocationCapabilities = { known: ReadonlySet<string>; authorized: ReadonlySet<string> }

/** Invocation-scoped capability projection. It never exposes executor handles. */
export class CapabilityRegistry {
  private readonly entries = new Map<string, InvocationCapabilities>()

  define(invocationId: string, knownCapabilityIds: readonly string[], authorizedCapabilityIds: readonly string[] = knownCapabilityIds): void {
    const known = new Set(knownCapabilityIds)
    if (authorizedCapabilityIds.some((id) => !known.has(id))) throw new Error('authorized capability must be known')
    this.entries.set(invocationId, { known, authorized: new Set(authorizedCapabilityIds) })
  }

  lookup(invocationId: string, requestedId: string): CapabilityLookup {
    const entry = this.entries.get(invocationId)
    if (!entry || !entry.known.has(requestedId)) return { state: 'unknown', requestedId }
    return entry.authorized.has(requestedId)
      ? { state: 'known-authorized', id: requestedId }
      : { state: 'known-unauthorized', id: requestedId }
  }

  visible(invocationId: string): readonly string[] {
    return Object.freeze([...(this.entries.get(invocationId)?.authorized ?? [])])
  }

  remove(invocationId: string): void { this.entries.delete(invocationId) }
}
