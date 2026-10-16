import { createHash } from 'node:crypto'

export const EXECUTION_SUBJECT_SCHEMA_VERSION = 'execution-subject-v1'

export interface ExecutionSubjectInput {
  readonly toolName: string
  readonly invocationId: string
  readonly toolUseId: string
  readonly subject: Readonly<Record<string, unknown>>
}

export interface ExecutionSubjectEnvelope {
  readonly schemaVersion: typeof EXECUTION_SUBJECT_SCHEMA_VERSION
  readonly subjectDigest: string
  readonly toolName: string
  readonly invocationId: string
  readonly toolUseId: string
}

export function canonicalizeExecutionValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('EXECUTION_SUBJECT_NOT_CANONICAL')
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalizeExecutionValue)
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('EXECUTION_SUBJECT_NOT_CANONICAL')
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => [key, canonicalizeExecutionValue(record[key])]))
  }
  throw new Error('EXECUTION_SUBJECT_NOT_CANONICAL')
}

export function digestExecutionSubject(input: ExecutionSubjectInput): string {
  if (!input.toolName.trim() || !input.invocationId.trim() || !input.toolUseId.trim()) throw new Error('EXECUTION_SUBJECT_IDENTITY_REQUIRED')
  const payload = canonicalizeExecutionValue({ schemaVersion: EXECUTION_SUBJECT_SCHEMA_VERSION, toolName: input.toolName, invocationId: input.invocationId, toolUseId: input.toolUseId, subject: input.subject })
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`
}

export function digestCanonicalExecutionValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalizeExecutionValue(value))).digest('hex')
}

export function createExecutionSubject(input: ExecutionSubjectInput): ExecutionSubjectEnvelope {
  return Object.freeze({
    schemaVersion: EXECUTION_SUBJECT_SCHEMA_VERSION,
    subjectDigest: digestExecutionSubject(input),
    toolName: input.toolName,
    invocationId: input.invocationId,
    toolUseId: input.toolUseId
  })
}
