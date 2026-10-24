export const SESSION_EVENT_TYPES = [
  'turn_start', 'turn_end', 'step_start', 'step_end', 'assistant_chunk', 'tool_call', 'tool_result',
  'request_header', 'request_context', 'request_usage', 'request_retry', 'compaction_start', 'compaction_summary',
  'compaction_end', 'session_end_seed'
] as const

export type SessionEventType = typeof SESSION_EVENT_TYPES[number]

export type SessionEventSchemaRecord = Readonly<{
  type: string
  schemaVersion?: number
  payload: Readonly<Record<string, unknown>>
  unsupportedSchema?: boolean
}>

export type NormalizedSessionEventSchema = Readonly<{
  type: SessionEventType
  schemaVersion: number
  payload: Readonly<Record<string, unknown>>
}>

const CURRENT_SCHEMA_VERSION: Readonly<Partial<Record<SessionEventType, number>>> = Object.freeze({
  tool_call: 2,
  tool_result: 2
})

const KNOWN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(SESSION_EVENT_TYPES)

/** Current writer version. Unlisted event types remain at schema version 1. */
export function currentSessionEventSchemaVersion(type: string): number | undefined {
  if (!KNOWN_EVENT_TYPE_SET.has(type)) return undefined
  return CURRENT_SCHEMA_VERSION[type as SessionEventType] ?? 1
}

/**
 * Upcasters normalize known historical event payloads before semantic projection checks.
 * Add a step here when a versioned event shape changes; unknown future versions stay opaque.
 */
const EVENT_UPCASTERS: Partial<Record<SessionEventType, Readonly<Record<number, (payload: Record<string, unknown>) => Record<string, unknown>>>>> = {
  // Version 2 adds optional request attribution to tool calls and a durable artifact reference to tool results.
  // Those fields are validated as additive metadata by the projection compatibility policy.
  tool_call: { 1: (payload) => ({ ...payload }) },
  tool_result: { 1: (payload) => ({ ...payload }) }
}

export function normalizeSessionEventSchema(record: SessionEventSchemaRecord): NormalizedSessionEventSchema | undefined {
  if (record.unsupportedSchema) return undefined
  const type = record.type
  if (!KNOWN_EVENT_TYPE_SET.has(type)) return undefined
  const normalizedType = type as SessionEventType
  let version = record.schemaVersion ?? 1
  if (!Number.isSafeInteger(version) || version < 1) return undefined
  const currentVersion = currentSessionEventSchemaVersion(type)
  if (currentVersion === undefined || version > currentVersion) return undefined
  let payload = { ...record.payload }
  const upcasters = EVENT_UPCASTERS[normalizedType]
  while (version < currentVersion) {
    const upcast = upcasters?.[version]
    if (!upcast) return undefined
    payload = upcast(payload)
    version += 1
  }
  return { type: normalizedType, schemaVersion: currentVersion, payload }
}
