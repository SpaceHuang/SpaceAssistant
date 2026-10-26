import { isDeepStrictEqual } from 'node:util'
import { normalizeSessionEventSchema, type SessionEventSchemaRecord } from './sessionEventSchema'

type FieldRule = Readonly<{
  path: readonly string[]
  isValid(value: unknown): boolean
  allowActualOnly?: boolean
}>

/**
 * Additive fields that do not change the event's semantic outcome. New schema fields
 * must be registered here (with a value validator) or represented by a migration.
 */
const ADDITIVE_PROJECTION_FIELDS: Readonly<Record<string, readonly FieldRule[]>> = Object.freeze({
  tool_call: [
    { path: ['requestId'], isValid: (value) => typeof value === 'string', allowActualOnly: true },
    { path: ['invocationRequestId'], isValid: (value) => typeof value === 'string', allowActualOnly: true },
    { path: ['lane'], isValid: (value) => typeof value === 'string', allowActualOnly: true }
  ],
  tool_result: [
    { path: ['result', 'data', 'rawArtifact', 'artifactId'], isValid: (value) => typeof value === 'string' && /^artifact-[a-f0-9]{64}$/i.test(value) }
  ]
})

/** Accepts tool_call records across the versioned additive request-attribution change. */
export function toolCallProjectionPayloadMatches(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>
): boolean {
  return payloadsMatch('tool_call', actual, expected)
}

/** Compares event identity/schema separately from payload fields, after a declared upcast path. */
export function sessionEventProjectionSchemasCompatible(actual: SessionEventSchemaRecord, expected: SessionEventSchemaRecord): boolean {
  const normalizedActual = normalizeSessionEventSchema(actual)
  const normalizedExpected = normalizeSessionEventSchema(expected)
  return Boolean(normalizedActual && normalizedExpected && normalizedActual.type === normalizedExpected.type &&
    normalizedActual.schemaVersion === normalizedExpected.schemaVersion)
}

/** Event type and schema are normalized before checking stable semantics and declared additive fields. */
export function sessionEventProjectionMatches(actual: SessionEventSchemaRecord, expected: SessionEventSchemaRecord): boolean {
  const normalizedActual = normalizeSessionEventSchema(actual)
  const normalizedExpected = normalizeSessionEventSchema(expected)
  if (!normalizedActual || !normalizedExpected || normalizedActual.type !== normalizedExpected.type ||
    normalizedActual.schemaVersion !== normalizedExpected.schemaVersion) return false
  return payloadsMatch(normalizedActual.type, normalizedActual.payload, normalizedExpected.payload)
}

function payloadsMatch(type: string, actual: Readonly<Record<string, unknown>>, expected: Readonly<Record<string, unknown>>): boolean {
  if (isDeepStrictEqual(actual, expected)) return true
  const rules = ADDITIVE_PROJECTION_FIELDS[type]
  if (!rules?.length) return false
  const compatibleActual = structuredClone(actual) as Record<string, unknown>
  const compatibleExpected = structuredClone(expected) as Record<string, unknown>
  let normalized = false
  for (const rule of rules) {
    const actualValue = readPath(compatibleActual, rule.path)
    const expectedValue = readPath(compatibleExpected, rule.path)
    if (actualValue.exists === expectedValue.exists) continue
    if (actualValue.exists && !expectedValue.exists && !rule.allowActualOnly) return false
    const value = actualValue.exists ? actualValue.value : expectedValue.value
    if (!rule.isValid(value)) return false
    deletePath(compatibleActual, rule.path)
    deletePath(compatibleExpected, rule.path)
    pruneEmptyParents(compatibleActual, compatibleExpected, rule.path)
    pruneEmptyParents(compatibleExpected, compatibleActual, rule.path)
    normalized = true
  }
  return normalized && isDeepStrictEqual(compatibleActual, compatibleExpected)
}

function readPath(root: Record<string, unknown>, path: readonly string[]): { exists: boolean; value?: unknown } {
  let current: unknown = root
  for (const key of path) {
    const record = asRecord(current)
    if (!record || !Object.hasOwn(record, key)) return { exists: false }
    current = record[key]
  }
  return { exists: true, value: current }
}

function deletePath(root: Record<string, unknown>, path: readonly string[]): void {
  let current: Record<string, unknown> = root
  for (const key of path.slice(0, -1)) {
    const child = asRecord(current[key])
    if (!child) return
    current[key] = { ...child }
    current = current[key] as Record<string, unknown>
  }
  delete current[path[path.length - 1]!]
}

function pruneEmptyParents(root: Record<string, unknown>, counterpart: Record<string, unknown>, path: readonly string[]): void {
  for (let depth = path.length - 1; depth > 0; depth -= 1) {
    const parentPath = path.slice(0, depth)
    const parent = readPath(root, parentPath)
    const counterpartParent = readPath(counterpart, parentPath)
    const parentRecord = asRecord(parent.value)
    if (parent.exists && parentRecord && Object.keys(parentRecord).length === 0 && !counterpartParent.exists) deletePath(root, parentPath)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Accepts execution diagnostics added by the live tool-result projection when canonical recovery replays its base result. */
export function toolResultProjectionPayloadMatches(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>
): boolean {
  const compatibleActual = { ...actual }
  const compatibleExpected = { ...expected }
  const actualResult = actual.result
  const expectedResult = expected.result
  if (!actualResult || typeof actualResult !== 'object' || Array.isArray(actualResult) ||
    !expectedResult || typeof expectedResult !== 'object' || Array.isArray(expectedResult)) {
    return isDeepStrictEqual(compatibleActual, compatibleExpected)
  }
  const nextActualResult = { ...(actualResult as Record<string, unknown>) }
  const nextExpectedResult = { ...(expectedResult as Record<string, unknown>) }
  const allowedDiagnostics: Readonly<Record<string, readonly unknown[]>> = {
    executionOutcome: ['succeeded', 'known-failure', 'unknown-after-dispatch', 'not-dispatched'],
    executorEntry: ['not-entered', 'entered', 'unknown']
  }
  for (const [key, values] of Object.entries(allowedDiagnostics)) {
    if (nextExpectedResult[key] === undefined && nextActualResult[key] !== undefined && values.includes(nextActualResult[key])) {
      delete nextActualResult[key]
    }
  }
  compatibleActual.result = nextActualResult
  compatibleExpected.result = nextExpectedResult
  return payloadsMatch('tool_result', compatibleActual, compatibleExpected)
}
