import { randomUUID } from 'node:crypto'
import type { RuntimeTriggerCondition, RuntimeTriggerDtoV1, RuntimeTriggerFailure, RuntimeTriggerOperationDto, RuntimeTriggerPageDto, RuntimeTriggerTargetDto, RuntimeTriggerTargetsDto } from '../../src/shared/domainTypes'
import type { SessionCommands } from '../sessionStorage/public/ports'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'
import { parseRuntimeTriggerCancelParams, parseRuntimeTriggerDefinition, parseRuntimeTriggerGetParams, parseRuntimeTriggerPageParams, parseRuntimeTriggerRegisterParams, runtimeTriggerFailure } from './protocol'
import { findRuntimeTriggerByClientKey, insertRuntimeTrigger, readRuntimeTrigger, updateRuntimeTrigger } from './store'

const DAY_MS = 86_400_000
const DEFAULT_OWNER_ACTIVE_LIMIT = 128
const DEFAULT_GLOBAL_ACTIVE_LIMIT = 4096
const DEFAULT_MAX_LIFETIME_MS = 30 * DAY_MS

export class RuntimeTriggerServiceError extends Error {
  constructor(readonly failure: RuntimeTriggerFailure) { super(`${failure.code}:${failure.case}`); this.name = 'RuntimeTriggerServiceError' }
}

export type RuntimeTriggerServiceOptions = Readonly<{
  now?: () => number
  maxActivePerOwner?: number
  maxActiveGlobal?: number
  maxLifetimeMs?: number
  /** Authorization boundary supplied by host policy; params never supply its result. */
  authorize: (input: { ownerSessionId: string; receiverSessionId: string; condition: RuntimeTriggerCondition }) => boolean
  authorizeTarget: (input: { ownerSessionId: string; target: RuntimeTriggerTargetDto }) => boolean
  listTargets?: (ownerSessionId: string) => readonly RuntimeTriggerTargetDto[]
  cancelSyncWait?: (record: RuntimeTriggerRecord) => void
  resolveBaseline?: (input: { ownerSessionId: string; condition: RuntimeTriggerCondition }) => Readonly<Record<string, unknown>>
}>

function fail(code: RuntimeTriggerFailure['code'], caseId: string): never { throw new RuntimeTriggerServiceError(runtimeTriggerFailure(code, caseId)) }
function isSync(record: RuntimeTriggerRecord): boolean { return record.definition.condition.type === 'session_steps' && record.definition.condition.mode === 'sync' }
function toDto(record: RuntimeTriggerRecord): RuntimeTriggerDtoV1 {
  const result = record.result
  const code = result?.code
  const caseId = result?.case
  const failure = typeof code === 'string' && typeof caseId === 'string' && code.startsWith('TRIGGER_')
    ? runtimeTriggerFailure(code as RuntimeTriggerFailure['code'], caseId) : undefined
  return { triggerId: record.id, ownerSessionId: record.ownerSessionId, receiverSessionId: record.receiverSessionId, clientKey: record.clientKey,
    definition: parseRuntimeTriggerDefinition(record.definition), state: record.state, createdAt: record.createdAt, expiresAt: record.expiresAt,
    ...(record.matchedAt !== undefined ? { matchedAt: record.matchedAt } : {}), ...(record.messageId ? { messageId: record.messageId } : {}),
    revision: record.revision, ...(failure ? { failure } : {}) }
}
function sameRegistration(prior: RuntimeTriggerRecord, input: { receiverSessionId: string; expiresAt: number; condition: RuntimeTriggerCondition }): boolean {
  return prior.receiverSessionId === input.receiverSessionId && prior.expiresAt === input.expiresAt && JSON.stringify(prior.definition.condition) === JSON.stringify(input.condition)
}
function decodeCursor(cursor?: string): { createdAt: number; id: string } | undefined {
  if (!cursor) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown }
    if (!Number.isSafeInteger(decoded.createdAt) || typeof decoded.id !== 'string' || !decoded.id) throw new Error()
    return { createdAt: Number(decoded.createdAt), id: decoded.id }
  } catch { fail('TRIGGER_INVALID', 'page-cursor-invalid') }
}
function encodeCursor(record: RuntimeTriggerRecord): string { return Buffer.from(JSON.stringify({ createdAt: record.createdAt, id: record.id })).toString('base64url') }

export function createRuntimeTriggerService(commands: SessionCommands, options: RuntimeTriggerServiceOptions) {
  const now = options.now ?? Date.now
  const ownerLimit = options.maxActivePerOwner ?? DEFAULT_OWNER_ACTIVE_LIMIT
  const globalLimit = options.maxActiveGlobal ?? DEFAULT_GLOBAL_ACTIVE_LIMIT
  const maxLifetime = options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS
  const authorize = (ownerSessionId: string, receiverSessionId: string, condition: RuntimeTriggerCondition) => {
    if (!options.authorize({ ownerSessionId, receiverSessionId, condition })) fail('TRIGGER_NOT_FOUND_OR_FORBIDDEN', 'session-not-authorized')
  }
  return {
    register(input: { ownerSessionId: string; params: unknown }): RuntimeTriggerOperationDto {
      const ownerSessionId = input.ownerSessionId
      if (!ownerSessionId?.trim()) fail('TRIGGER_NOT_FOUND_OR_FORBIDDEN', 'owner-not-authorized')
      const params = parseRuntimeTriggerRegisterParams(input.params)
      const timestamp = now()
      if (!Number.isSafeInteger(timestamp)) fail('TRIGGER_STORAGE_UNAVAILABLE', 'clock-invalid')
      authorize(ownerSessionId, params.receiverSessionId, params.condition)
      const condition = params.condition
      if (condition.type === 'session_steps' && condition.mode === 'sync' && condition.targetSessionId === params.receiverSessionId) fail('TRIGGER_CONFLICT', 'sync-self-wait')
      const prior = findRuntimeTriggerByClientKey(commands, ownerSessionId, params.clientKey)
      if (prior) {
        if (!sameRegistration(prior, params)) fail('TRIGGER_CONFLICT', 'client-key-definition-mismatch')
        return { trigger: toDto(prior), replayed: true }
      }
      if (!Number.isSafeInteger(params.expiresAt) || params.expiresAt <= timestamp || params.expiresAt - timestamp > maxLifetime) fail('TRIGGER_INVALID', 'expiry-out-of-range')
      const baseline = options.resolveBaseline?.({ ownerSessionId, condition }) ?? {}
      const definition = { version: 1 as const, condition, sourceBaseline: structuredClone(baseline) }
      if (condition.type === 'session_steps' && condition.mode === 'sync') {
        const activeSync = commands.runtimeTriggers.findActiveSyncTarget(params.receiverSessionId)
        if (activeSync && activeSync.expiresAt <= timestamp) updateRuntimeTrigger(commands, activeSync.id, activeSync.revision, { state: 'expired', updatedAt: timestamp })
        else if (activeSync) fail('TRIGGER_CONFLICT', 'sync-target-already-registered')
      }
      if (commands.runtimeTriggers.countActive({ ownerSessionId, now: timestamp }) >= ownerLimit) fail('TRIGGER_CAPACITY', 'owner-active-limit')
      if (commands.runtimeTriggers.countActive({ now: timestamp }) >= globalLimit) fail('TRIGGER_CAPACITY', 'application-active-limit')
      const record: RuntimeTriggerRecord = { id: randomUUID(), ownerSessionId, receiverSessionId: params.receiverSessionId, clientKey: params.clientKey,
        definition, state: 'waiting', createdAt: timestamp, expiresAt: params.expiresAt, attempts: 0, revision: 1, updatedAt: timestamp }
      try { return { trigger: toDto(insertRuntimeTrigger(commands, record)) } }
      catch (error) {
        const raced = findRuntimeTriggerByClientKey(commands, ownerSessionId, params.clientKey)
        if (raced && sameRegistration(raced, params)) return { trigger: toDto(raced), replayed: true }
        if (condition.type === 'session_steps' && condition.mode === 'sync') fail('TRIGGER_CONFLICT', 'sync-target-already-registered')
        throw error
      }
    },
    get(input: { ownerSessionId: string; triggerId: unknown }): RuntimeTriggerOperationDto {
      const { triggerId } = parseRuntimeTriggerGetParams({ triggerId: input.triggerId })
      const record = readRuntimeTrigger(commands, triggerId)
      if (!record || record.ownerSessionId !== input.ownerSessionId) fail('TRIGGER_NOT_FOUND_OR_FORBIDDEN', 'not-found-or-forbidden')
      return { trigger: toDto(record) }
    },
    list(input: { ownerSessionId: string; params: unknown }): RuntimeTriggerPageDto {
      const params = parseRuntimeTriggerPageParams(input.params)
      const limit = params.limit ?? 20
      const rows = commands.runtimeTriggers.listByOwner({ ownerSessionId: input.ownerSessionId, cursor: decodeCursor(params.cursor), limit })
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      return { items: page.map(toDto), ...(hasMore && page.length ? { nextCursor: encodeCursor(page[page.length - 1]!) } : {}) }
    },
    cancel(input: { ownerSessionId: string; params: unknown }): RuntimeTriggerOperationDto {
      const params = parseRuntimeTriggerCancelParams(input.params)
      const record = readRuntimeTrigger(commands, params.triggerId)
      if (!record || record.ownerSessionId !== input.ownerSessionId) fail('TRIGGER_NOT_FOUND_OR_FORBIDDEN', 'not-found-or-forbidden')
      const cancelMatchedSync = record.state === 'matched' && isSync(record)
      if (record.state !== 'waiting' && !cancelMatchedSync) fail('TRIGGER_CONFLICT', 'terminal-state')
      if (cancelMatchedSync && !options.cancelSyncWait) fail('TRIGGER_CONFLICT', 'sync-wait-control-unavailable')
      const updated = updateRuntimeTrigger(commands, record.id, params.expectedRevision, { state: 'cancelled', updatedAt: now() })
      if (!updated) fail('TRIGGER_CONFLICT', 'revision-changed')
      if (cancelMatchedSync) options.cancelSyncWait?.(record)
      return { trigger: toDto(updated) }
    },
    targets(input: { ownerSessionId: string; params: unknown }): RuntimeTriggerTargetsDto {
      const params = parseRuntimeTriggerPageParams(input.params)
      const visible = (options.listTargets?.(input.ownerSessionId) ?? []).filter((target) => options.authorizeTarget({ ownerSessionId: input.ownerSessionId, target }))
      const cursor = params.cursor
      const cursorIndex = cursor ? visible.findIndex((item) => item.id === cursor) : -1
      if (cursor && cursorIndex < 0) fail('TRIGGER_INVALID', 'target-page-cursor-invalid')
      const start = cursor ? cursorIndex + 1 : 0
      const limit = params.limit ?? 20
      const items = visible.slice(start, start + limit)
      return { items, ...(start + items.length < visible.length && items.length ? { nextCursor: items[items.length - 1]!.id } : {}) }
    },
    match(input: { triggerId: string; expectedRevision: number; event: Readonly<Record<string, unknown>> }): RuntimeTriggerRecord | null {
      const record = readRuntimeTrigger(commands, input.triggerId)
      if (!record || record.state !== 'waiting') return null
      if (record.expiresAt <= now()) {
        updateRuntimeTrigger(commands, record.id, input.expectedRevision, { state: 'expired', updatedAt: now() })
        return null
      }
      return updateRuntimeTrigger(commands, record.id, input.expectedRevision, { state: 'matched', matchedAt: now(), event: structuredClone(input.event), updatedAt: now() })
    },
    expire(input: { triggerId: string; expectedRevision: number }): RuntimeTriggerOperationDto {
      const record = readRuntimeTrigger(commands, input.triggerId)
      if (!record) fail('TRIGGER_NOT_FOUND_OR_FORBIDDEN', 'not-found-or-forbidden')
      if (record.state !== 'waiting' && record.state !== 'matched') fail('TRIGGER_CONFLICT', 'terminal-state')
      if (record.expiresAt > now()) fail('TRIGGER_CONFLICT', 'not-yet-expired')
      const updated = updateRuntimeTrigger(commands, record.id, input.expectedRevision, { state: 'expired', updatedAt: now() })
      if (!updated) fail('TRIGGER_CONFLICT', 'revision-changed')
      return { trigger: toDto(updated) }
    },
    fail(input: { triggerId: string; expectedRevision: number; code: RuntimeTriggerFailure['code']; caseId: string }): RuntimeTriggerOperationDto {
      const record = readRuntimeTrigger(commands, input.triggerId)
      if (!record) fail('TRIGGER_NOT_FOUND_OR_FORBIDDEN', 'not-found-or-forbidden')
      if (record.state !== 'waiting' && record.state !== 'matched') fail('TRIGGER_CONFLICT', 'terminal-state')
      const failure = runtimeTriggerFailure(input.code, input.caseId)
      const updated = updateRuntimeTrigger(commands, record.id, input.expectedRevision, { state: 'failed', result: failure, updatedAt: now() })
      if (!updated) fail('TRIGGER_CONFLICT', 'revision-changed')
      return { trigger: toDto(updated) }
    }
  }
}
