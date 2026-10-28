export type SessionSwitchTraceMetadata = Readonly<{ processId?: number; requestOrdinal: number; requestInitiatedAtEpochMs?: number }>

const SESSION_SWITCH_TRACE_METADATA = Symbol.for('spaceassistant.session-switch-trace-metadata.v1')

export type SessionSwitchTraceCounter = { __spaceAssistantSessionSwitchOrdinal?: number }

export function nextSessionSwitchTraceOrdinal(state: SessionSwitchTraceCounter): number {
  const next = (state.__spaceAssistantSessionSwitchOrdinal ?? 0) + 1
  if (!Number.isSafeInteger(next) || next < 1) throw new Error('SESSION_SWITCH_TRACE_ORDINAL_EXHAUSTED')
  state.__spaceAssistantSessionSwitchOrdinal = next
  return next
}

export function attachSessionSwitchTraceMetadata<T extends object>(value: T, metadata: SessionSwitchTraceMetadata): T {
  if ((metadata.processId !== undefined && (!Number.isSafeInteger(metadata.processId) || metadata.processId < 0)) ||
    !Number.isSafeInteger(metadata.requestOrdinal) || metadata.requestOrdinal < 1 ||
    (metadata.requestInitiatedAtEpochMs !== undefined && !isValidEpochMs(metadata.requestInitiatedAtEpochMs))) {
    throw new Error('SESSION_SWITCH_TRACE_METADATA_INVALID')
  }
  Object.defineProperty(value, SESSION_SWITCH_TRACE_METADATA, {
    value: Object.freeze({ processId: metadata.processId, requestOrdinal: metadata.requestOrdinal,
      requestInitiatedAtEpochMs: metadata.requestInitiatedAtEpochMs }),
    enumerable: false,
    configurable: false,
    writable: false
  })
  return value
}

export function readSessionSwitchTraceMetadata(value: unknown): SessionSwitchTraceMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined
  const metadata = (value as Record<PropertyKey, unknown>)[SESSION_SWITCH_TRACE_METADATA]
  if (!metadata || typeof metadata !== 'object') return undefined
  const candidate = metadata as Record<string, unknown>
  if ((candidate.processId !== undefined && (!Number.isSafeInteger(candidate.processId) || Number(candidate.processId) < 0)) ||
    !Number.isSafeInteger(candidate.requestOrdinal) || Number(candidate.requestOrdinal) < 1 ||
    (candidate.requestInitiatedAtEpochMs !== undefined && !isValidEpochMs(candidate.requestInitiatedAtEpochMs))) return undefined
  return { ...(candidate.processId === undefined ? {} : { processId: Number(candidate.processId) }), requestOrdinal: Number(candidate.requestOrdinal),
    ...(candidate.requestInitiatedAtEpochMs === undefined ? {} : { requestInitiatedAtEpochMs: Number(candidate.requestInitiatedAtEpochMs) }) }
}

function isValidEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1_000_000_000_000 && value <= 10_000_000_000_000
}
