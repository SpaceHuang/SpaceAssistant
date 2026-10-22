export type ProjectionHistoryChunkPermit = Readonly<{
  dbPath: string
  sessionId: string
  sessionGeneration: string
  scopeKey: string
  specVersion: number
  sourceIdentityJson: string
  connectionEpoch: number
  processGeneration: number
  rebuildToken: string
}>

export type ProjectionHistoryChunkEvent = Readonly<{
  invocationId: string
  sequence: number
  eventId: string
  idempotencyKey: string
  turnId: string
  schemaVersion: number
  kind: string
  payloadJson: string
  sessionSequence: number
  commitOrder: number
  createdAt: number
}>

/** Same-snapshot message facts used by scope reducers to bind History bodies to stored identity/authority. */
export type ProjectionMessageFact = Readonly<{
  id: string
  role: string
  timestamp: number
  sequence: number
  queueScope: string
  contentStorageState: 'legacy' | 'canonical-backed-dual-write' | 'canonical-backed-only'
  writeMode: string | null
  storedContent: string
}>

export type ProjectionHistoryChunkResult =
  | Readonly<{ kind: 'chunk'; permit: ProjectionHistoryChunkPermit; afterSessionSequence: number; nextSessionSequence: number; events: readonly ProjectionHistoryChunkEvent[]; messageFacts: readonly ProjectionMessageFact[]; byteLength: number; hasMore: boolean }>
  | Readonly<{ kind: 'complete'; permit: ProjectionHistoryChunkPermit; afterSessionSequence: number }>
  | Readonly<{ kind: 'source-drift' | 'cursor-invalid' | 'deferred-large' | 'unavailable'; permit: ProjectionHistoryChunkPermit; afterSessionSequence: number; eventSequence?: number; reason?: string }>
