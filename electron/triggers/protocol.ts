import type { RuntimeTriggerAdmissionV1, RuntimeTriggerCondition, RuntimeTriggerDefinitionV1, RuntimeTriggerDtoV1, RuntimeTriggerFailure, RuntimeTriggerOperationDto, RuntimeTriggerPageDto, RuntimeTriggerTargetDto, RuntimeTriggerTargetsDto } from '../../src/shared/domainTypes'

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const ownKeysAre = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key))

export class RuntimeTriggerProtocolError extends Error {
  readonly code = 'TRIGGER_INVALID' as const
  constructor(readonly caseId: string) { super(`runtime trigger input is invalid: ${caseId}`); this.name = 'RuntimeTriggerProtocolError' }
}

export function parseRuntimeTriggerCondition(value: unknown): RuntimeTriggerCondition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeTriggerProtocolError('condition-object-required')
  const record = value as Record<string, unknown>
  switch (record.type) {
    case 'turn_completed':
      if (!ownKeysAre(record, ['type', 'targetSessionId', 'turnId']) || !nonEmpty(record.targetSessionId) || !nonEmpty(record.turnId)) throw new RuntimeTriggerProtocolError('turn-condition-invalid')
      return { type: 'turn_completed', targetSessionId: record.targetSessionId, turnId: record.turnId }
    case 'session_steps':
      if (record.origin !== 'registration' || !nonEmpty(record.targetSessionId) || !Number.isSafeInteger(record.threshold) || Number(record.threshold) <= 0) throw new RuntimeTriggerProtocolError('steps-condition-invalid')
      if (record.mode === 'async' && ownKeysAre(record, ['type', 'targetSessionId', 'origin', 'threshold', 'mode'])) return { type: 'session_steps', targetSessionId: record.targetSessionId, origin: 'registration', threshold: Number(record.threshold), mode: 'async' }
      if (record.mode === 'sync' && ownKeysAre(record, ['type', 'targetSessionId', 'origin', 'threshold', 'mode', 'pauseTimeoutMs', 'onPauseTimeout']) &&
        Number.isFinite(record.pauseTimeoutMs) && Number(record.pauseTimeoutMs) > 0 && (record.onPauseTimeout === 'continue' || record.onPauseTimeout === 'fail')) {
        return { type: 'session_steps', targetSessionId: record.targetSessionId, origin: 'registration', threshold: Number(record.threshold), mode: 'sync', pauseTimeoutMs: Number(record.pauseTimeoutMs), onPauseTimeout: record.onPauseTimeout }
      }
      throw new RuntimeTriggerProtocolError('steps-mode-invalid')
    case 'process_exit':
      if (!ownKeysAre(record, ['type', 'managedProcessId']) || !nonEmpty(record.managedProcessId)) throw new RuntimeTriggerProtocolError('process-condition-invalid')
      return { type: 'process_exit', managedProcessId: record.managedProcessId }
    case 'im_message':
      if (!ownKeysAre(record, ['type', 'channel', 'accountId', 'conversationId', 'senderIds', 'bodyContains']) ||
        (record.channel !== 'feishu' && record.channel !== 'wechat') || !nonEmpty(record.accountId) || !nonEmpty(record.conversationId) ||
        (record.senderIds !== undefined && (!Array.isArray(record.senderIds) || !record.senderIds.every(nonEmpty))) ||
        (record.bodyContains !== undefined && !nonEmpty(record.bodyContains))) throw new RuntimeTriggerProtocolError('im-condition-invalid')
      return { type: 'im_message', channel: record.channel, accountId: record.accountId, conversationId: record.conversationId,
        ...(record.senderIds ? { senderIds: record.senderIds as string[] } : {}), ...(record.bodyContains ? { bodyContains: record.bodyContains as string } : {}) }
    case 'agent_session_message':
      if (!ownKeysAre(record, ['type', 'requestId']) || !nonEmpty(record.requestId)) throw new RuntimeTriggerProtocolError('agent-message-condition-invalid')
      return { type: 'agent_session_message', requestId: record.requestId }
    case 'time':
      if (!ownKeysAre(record, ['type', 'at', 'taskPrompt']) || !nonEmpty(record.at) || !nonEmpty(record.taskPrompt) || !Number.isFinite(Date.parse(record.at)) || !/([zZ]|[+-]\d{2}:?\d{2})$/.test(record.at)) throw new RuntimeTriggerProtocolError('time-condition-invalid')
      return { type: 'time', at: record.at, taskPrompt: record.taskPrompt }
    default: throw new RuntimeTriggerProtocolError('condition-type-unsupported')
  }
}

export function parseRuntimeTriggerRegisterParams(value: unknown): { clientKey: string; receiverSessionId: string; expiresAt: number; condition: RuntimeTriggerCondition } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeTriggerProtocolError('register-object-required')
  const record = value as Record<string, unknown>
  if (!ownKeysAre(record, ['clientKey', 'receiverSessionId', 'expiresAt', 'condition']) || !nonEmpty(record.clientKey) || !nonEmpty(record.receiverSessionId) ||
    !Number.isSafeInteger(record.expiresAt) || Number(record.expiresAt) <= 0) throw new RuntimeTriggerProtocolError('register-fields-invalid')
  const condition = parseRuntimeTriggerCondition(record.condition)
  if (condition.type === 'time' && Date.parse(condition.at) > Number(record.expiresAt)) throw new RuntimeTriggerProtocolError('time-after-expiry')
  return { clientKey: record.clientKey, receiverSessionId: record.receiverSessionId, expiresAt: Number(record.expiresAt), condition }
}

export function parseRuntimeTriggerDefinition(value: unknown): RuntimeTriggerDefinitionV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeTriggerProtocolError('definition-object-required')
  const record = value as Record<string, unknown>
  if (!ownKeysAre(record, ['version', 'condition', 'sourceBaseline']) || record.version !== 1 || !record.sourceBaseline || typeof record.sourceBaseline !== 'object' || Array.isArray(record.sourceBaseline)) {
    throw new RuntimeTriggerProtocolError('definition-v1-invalid')
  }
  return { version: 1, condition: parseRuntimeTriggerCondition(record.condition), sourceBaseline: structuredClone(record.sourceBaseline as Record<string, unknown>) }
}

export function parseRuntimeTriggerGetParams(value: unknown): { triggerId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ownKeysAre(value as Record<string, unknown>, ['triggerId']) || !nonEmpty((value as Record<string, unknown>).triggerId)) {
    throw new RuntimeTriggerProtocolError('get-fields-invalid')
  }
  return { triggerId: (value as { triggerId: string }).triggerId }
}

export function parseRuntimeTriggerCancelParams(value: unknown): { triggerId: string; expectedRevision: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ownKeysAre(value as Record<string, unknown>, ['triggerId', 'expectedRevision'])) {
    throw new RuntimeTriggerProtocolError('cancel-fields-invalid')
  }
  const record = value as Record<string, unknown>
  if (!nonEmpty(record.triggerId) || !Number.isSafeInteger(record.expectedRevision) || Number(record.expectedRevision) <= 0) throw new RuntimeTriggerProtocolError('cancel-fields-invalid')
  return { triggerId: record.triggerId, expectedRevision: Number(record.expectedRevision) }
}

export function parseRuntimeTriggerPageParams(value: unknown): { cursor?: string; limit?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ownKeysAre(value as Record<string, unknown>, ['cursor', 'limit'])) throw new RuntimeTriggerProtocolError('page-fields-invalid')
  const record = value as Record<string, unknown>
  if (record.cursor !== undefined && !nonEmpty(record.cursor)) throw new RuntimeTriggerProtocolError('page-cursor-invalid')
  if (record.limit !== undefined && (!Number.isSafeInteger(record.limit) || Number(record.limit) < 1 || Number(record.limit) > 100)) throw new RuntimeTriggerProtocolError('page-limit-invalid')
  return { ...(record.cursor ? { cursor: record.cursor as string } : {}), ...(record.limit !== undefined ? { limit: Number(record.limit) } : {}) }
}

const triggerStates = ['waiting', 'matched', 'completed', 'cancelled', 'expired', 'failed', 'queued', 'processing', 'delivery_pending'] as const
const triggerFailureCodes = ['TRIGGER_INVALID', 'TRIGGER_NOT_FOUND_OR_FORBIDDEN', 'TRIGGER_CONFLICT', 'TRIGGER_CAPACITY', 'TRIGGER_EXPIRED', 'TRIGGER_TARGET_LOST', 'TRIGGER_SOURCE_GAP', 'TRIGGER_DELIVERY_FAILED', 'TRIGGER_HANDLING_FAILED', 'TRIGGER_STORAGE_UNAVAILABLE'] as const

export function parseRuntimeTriggerFailure(value: unknown): RuntimeTriggerFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ownKeysAre(value as Record<string, unknown>, ['code', 'case', 'currentState', 'revision'])) throw new RuntimeTriggerProtocolError('failure-dto-invalid')
  const record = value as Record<string, unknown>
  if (!triggerFailureCodes.includes(record.code as typeof triggerFailureCodes[number]) || !nonEmpty(record.case) ||
    (record.currentState !== undefined && !triggerStates.includes(record.currentState as typeof triggerStates[number])) ||
    (record.revision !== undefined && (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1))) throw new RuntimeTriggerProtocolError('failure-dto-invalid')
  return { code: record.code as RuntimeTriggerFailure['code'], case: record.case, ...(record.currentState ? { currentState: record.currentState as RuntimeTriggerFailure['currentState'] } : {}), ...(record.revision !== undefined ? { revision: Number(record.revision) } : {}) }
}

export function parseRuntimeTriggerDto(value: unknown): RuntimeTriggerDtoV1 {
  const keys = ['triggerId', 'ownerSessionId', 'receiverSessionId', 'clientKey', 'definition', 'state', 'createdAt', 'expiresAt', 'matchedAt', 'messageId', 'revision', 'failure']
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ownKeysAre(value as Record<string, unknown>, keys)) throw new RuntimeTriggerProtocolError('trigger-dto-invalid')
  const record = value as Record<string, unknown>
  if (!nonEmpty(record.triggerId) || !nonEmpty(record.ownerSessionId) || !nonEmpty(record.receiverSessionId) || !nonEmpty(record.clientKey) ||
    !triggerStates.includes(record.state as typeof triggerStates[number]) || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) ||
    (record.matchedAt !== undefined && !Number.isSafeInteger(record.matchedAt)) || (record.messageId !== undefined && !nonEmpty(record.messageId)) ||
    !Number.isSafeInteger(record.revision) || Number(record.revision) < 1) throw new RuntimeTriggerProtocolError('trigger-dto-invalid')
  const definition = parseRuntimeTriggerDefinition(record.definition)
  const failure = record.failure === undefined ? undefined : parseRuntimeTriggerFailure(record.failure)
  return { triggerId: record.triggerId, ownerSessionId: record.ownerSessionId, receiverSessionId: record.receiverSessionId, clientKey: record.clientKey,
    definition, state: record.state as RuntimeTriggerDtoV1['state'], createdAt: Number(record.createdAt), expiresAt: Number(record.expiresAt),
    ...(record.matchedAt !== undefined ? { matchedAt: Number(record.matchedAt) } : {}), ...(record.messageId !== undefined ? { messageId: record.messageId as string } : {}),
    revision: Number(record.revision), ...(failure ? { failure } : {}) }
}

export function parseRuntimeTriggerPageDto(value: unknown): RuntimeTriggerPageDto {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ownKeysAre(value as Record<string, unknown>, ['items', 'nextCursor'])) throw new RuntimeTriggerProtocolError('page-dto-invalid')
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.items) || record.items.length > 100 || (record.nextCursor !== undefined && !nonEmpty(record.nextCursor))) throw new RuntimeTriggerProtocolError('page-dto-invalid')
  return { items: record.items.map(parseRuntimeTriggerDto), ...(record.nextCursor ? { nextCursor: record.nextCursor as string } : {}) }
}

export function parseRuntimeTriggerTargetDto(value: unknown): RuntimeTriggerTargetDto {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ownKeysAre(value as Record<string, unknown>, ['kind', 'id', 'label', 'status'])) throw new RuntimeTriggerProtocolError('target-dto-invalid')
  const record = value as Record<string, unknown>
  if ((record.kind !== 'session' && record.kind !== 'managed-process') || !nonEmpty(record.id) || !nonEmpty(record.label) || (record.status !== undefined && !nonEmpty(record.status))) throw new RuntimeTriggerProtocolError('target-dto-invalid')
  return { kind: record.kind, id: record.id, label: record.label, ...(record.status ? { status: record.status as string } : {}) }
}

export function parseRuntimeTriggerTargetsDto(value: unknown): RuntimeTriggerTargetsDto {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ownKeysAre(value as Record<string, unknown>, ['items', 'nextCursor'])) throw new RuntimeTriggerProtocolError('targets-dto-invalid')
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.items) || record.items.length > 100 || (record.nextCursor !== undefined && !nonEmpty(record.nextCursor))) throw new RuntimeTriggerProtocolError('targets-dto-invalid')
  return { items: record.items.map(parseRuntimeTriggerTargetDto), ...(record.nextCursor ? { nextCursor: record.nextCursor as string } : {}) }
}

export function parseRuntimeTriggerOperationDto(value: unknown): RuntimeTriggerOperationDto {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ownKeysAre(value as Record<string, unknown>, ['trigger', 'replayed'])) throw new RuntimeTriggerProtocolError('operation-dto-invalid')
  const record = value as Record<string, unknown>
  if (record.replayed !== undefined && typeof record.replayed !== 'boolean') throw new RuntimeTriggerProtocolError('operation-dto-invalid')
  return { trigger: parseRuntimeTriggerDto(record.trigger), ...(record.replayed !== undefined ? { replayed: record.replayed } : {}) }
}

/** Stable host mapping for the SDK's two neutral lifecycle failures. */
export function mapLifecycleFailureToTriggerFailure(code: 'LIFECYCLE_CALLBACK_TIMEOUT' | 'LIFECYCLE_PAUSE_TIMEOUT'): RuntimeTriggerFailure {
  return runtimeTriggerFailure('TRIGGER_HANDLING_FAILED', code === 'LIFECYCLE_CALLBACK_TIMEOUT' ? 'callback-timeout' : 'pause-timeout')
}

export function parseRuntimeTriggerAdmission(value: unknown): RuntimeTriggerAdmissionV1 {
  const keys = ['version','triggerId','requestId','receiverSessionId','turnId','invocationId','contextEventId','contextDigest','payloadDigest','authorizationGeneration','policyRevision','acceptedAt']
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ownKeysAre(value as Record<string, unknown>, keys)) throw new RuntimeTriggerProtocolError('admission-v1-invalid')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !['triggerId','requestId','receiverSessionId','turnId','invocationId','contextEventId','contextDigest','payloadDigest','authorizationGeneration','policyRevision'].every((key) => nonEmpty(record[key])) ||
    !Number.isSafeInteger(record.acceptedAt) || Number(record.acceptedAt) <= 0) throw new RuntimeTriggerProtocolError('admission-v1-invalid')
  return { version: 1, triggerId: record.triggerId as string, requestId: record.requestId as string, receiverSessionId: record.receiverSessionId as string,
    turnId: record.turnId as string, invocationId: record.invocationId as string, contextEventId: record.contextEventId as string,
    contextDigest: record.contextDigest as string, payloadDigest: record.payloadDigest as string, authorizationGeneration: record.authorizationGeneration as string,
    policyRevision: record.policyRevision as string, acceptedAt: Number(record.acceptedAt) }
}

export function runtimeTriggerFailure(code: RuntimeTriggerFailure['code'], caseId: string, extras: Omit<RuntimeTriggerFailure, 'code' | 'case'> = {}): RuntimeTriggerFailure {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(caseId)) throw new TypeError('trigger failure case must be stable lowercase kebab-case')
  return { code, case: caseId, ...extras }
}
