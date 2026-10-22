export const PROJECTION_SCOPE_KINDS = [
  'chatBodyV1', 'transcriptParityV1', 'chatMessageV1', 'exportMessageV1', 'searchCorpusV1', 'globalMessageSearchV1',
  'apiBaselineV1', 'acceptedContextV1', 'routeV1', 'hostedCheckpointV1',
] as const

export type ProjectionScopeKeyKind = typeof PROJECTION_SCOPE_KINDS[number]

export interface ProjectionScopeDescriptor {
  scope: ProjectionScopeKeyKind
  specVersion: number
  trackId?: string
  window?: Readonly<{ fromSequence: number; toSequence: number }>
}

const TRACK_WINDOW_SCOPES = new Set<ProjectionScopeKeyKind>(['acceptedContextV1'])

/**
 * Encode the durable identity of a projection view. Selection parameters and source
 * watermarks intentionally stay outside this key; they belong to a query or proof.
 */
export function encodeProjectionScopeKey(descriptor: ProjectionScopeDescriptor): string {
  const { scope, specVersion, trackId, window } = descriptor
  if (!PROJECTION_SCOPE_KINDS.includes(scope)) throw new Error('INVALID_PROJECTION_SCOPE_KIND')
  if (!Number.isSafeInteger(specVersion) || specVersion < 1) throw new Error('INVALID_PROJECTION_SCOPE_SPEC_VERSION')

  const hasTrackWindow = trackId !== undefined || window !== undefined
  if (hasTrackWindow && !TRACK_WINDOW_SCOPES.has(scope)) throw new Error('UNSUPPORTED_PROJECTION_SCOPE_DIMENSION')
  if (trackId !== undefined && (typeof trackId !== 'string' || trackId.trim().length === 0)) {
    throw new Error('INVALID_PROJECTION_SCOPE_TRACK_ID')
  }
  if (window !== undefined && (
    !Number.isSafeInteger(window.fromSequence) || window.fromSequence < 0 ||
    !Number.isSafeInteger(window.toSequence) || window.toSequence < window.fromSequence
  )) throw new Error('INVALID_PROJECTION_SCOPE_WINDOW')

  const identity = [scope, specVersion, trackId ?? null, window ? [window.fromSequence, window.toSequence] : null]
  return `session-projection:${encodeURIComponent(JSON.stringify(identity))}`
}

/** Read and validate the stable spec version embedded in a durable projection scope key. */
export function projectionScopeSpecVersion(scopeKey: string): number | null {
  return decodeProjectionScopeIdentity(scopeKey)?.specVersion ?? null
}

export function projectionScopeKind(scopeKey: string): ProjectionScopeKeyKind | null {
  return decodeProjectionScopeIdentity(scopeKey)?.scope ?? null
}

function decodeProjectionScopeIdentity(scopeKey: string): ProjectionScopeDescriptor | null {
  const prefix = 'session-projection:'
  if (!scopeKey.startsWith(prefix)) return null
  try {
    const identity: unknown = JSON.parse(decodeURIComponent(scopeKey.slice(prefix.length)))
    if (!Array.isArray(identity) || identity.length !== 4 || !PROJECTION_SCOPE_KINDS.includes(identity[0]) ||
      !Number.isSafeInteger(identity[1]) || identity[1] < 1 ||
      (identity[2] !== null && typeof identity[2] !== 'string') ||
      (identity[3] !== null && (!Array.isArray(identity[3]) || identity[3].length !== 2 ||
        !Number.isSafeInteger(identity[3][0]) || !Number.isSafeInteger(identity[3][1]) || identity[3][0] < 0 || identity[3][1] < identity[3][0]))) return null
    const scope = identity[0] as ProjectionScopeKeyKind
    const specVersion = identity[1] as number
    const trackId = identity[2] as string | null
    const window = identity[3] as [number, number] | null
    return { scope, specVersion, ...(trackId === null ? {} : { trackId }), ...(window === null ? {} : { window: { fromSequence: window[0], toSequence: window[1] } }) }
  } catch { return null }
}
