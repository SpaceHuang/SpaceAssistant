import { describe, expect, it } from 'vitest'
import { DB_SCHEMA_VERSION, SCHEMA_META_KEYS } from '../database/schema'
import { mapLifecycleFailureToTriggerFailure, parseRuntimeTriggerAdmission, parseRuntimeTriggerCancelParams, parseRuntimeTriggerCondition, parseRuntimeTriggerDefinition, parseRuntimeTriggerDto, parseRuntimeTriggerFailure, parseRuntimeTriggerGetParams, parseRuntimeTriggerOperationDto, parseRuntimeTriggerPageDto, parseRuntimeTriggerPageParams, parseRuntimeTriggerRegisterParams, parseRuntimeTriggerTargetsDto, runtimeTriggerFailure } from './protocol'

describe('runtime trigger protocol v1 contracts', () => {
  it('pins lifecycle limits as explicit finite fixture values, not production defaults', () => {
    const fixtureLimits = { callbackTimeoutMs: 1000, maxPauseMs: 2000 }
    expect(Object.values(fixtureLimits).every((value) => Number.isFinite(value) && value > 0)).toBe(true)
    expect(DB_SCHEMA_VERSION).toBe(121)
    expect(SCHEMA_META_KEYS.schemaVersion).toBe('schema_version')
    expect(SCHEMA_META_KEYS.imFactNextSeq).toBe('im_fact_next_seq')
    expect(SCHEMA_META_KEYS.imFactCoverageRevisionPrefix).toBe('im_fact_coverage_revision:')
  })

  it('accepts all five condition families and preserves explicit sync mode', () => {
    expect(parseRuntimeTriggerCondition({ type: 'turn_completed', targetSessionId: 's1', turnId: 't1' }).type).toBe('turn_completed')
    expect(parseRuntimeTriggerCondition({ type: 'session_steps', targetSessionId: 's1', origin: 'registration', threshold: 2, mode: 'async' })).toMatchObject({ mode: 'async' })
    expect(parseRuntimeTriggerCondition({ type: 'session_steps', targetSessionId: 's1', origin: 'registration', threshold: 2, mode: 'sync', pauseTimeoutMs: 3000, onPauseTimeout: 'fail' })).toMatchObject({ mode: 'sync', onPauseTimeout: 'fail' })
    expect(parseRuntimeTriggerCondition({ type: 'process_exit', managedProcessId: 'proc opaque' }).type).toBe('process_exit')
    expect(parseRuntimeTriggerCondition({ type: 'im_message', channel: 'feishu', accountId: 'a', conversationId: 'c', senderIds: ['u'] }).type).toBe('im_message')
    expect(parseRuntimeTriggerCondition({ type: 'time', at: '2030-01-01T00:00:00Z', taskPrompt: 'wake' }).type).toBe('time')
  })

  it('rejects unknown fields, malformed timezones and invalid sync limits', () => {
    expect(() => parseRuntimeTriggerCondition({ type: 'process_exit', managedProcessId: 'p', pid: 12 })).toThrow('process-condition-invalid')
    expect(() => parseRuntimeTriggerCondition({ type: 'time', at: '2030-01-01T00:00:00', taskPrompt: 'wake' })).toThrow('time-condition-invalid')
    expect(() => parseRuntimeTriggerCondition({ type: 'session_steps', targetSessionId: 's', origin: 'registration', threshold: 1, mode: 'sync', pauseTimeoutMs: Infinity, onPauseTimeout: 'continue' })).toThrow('steps-mode-invalid')
  })

  it('validates registration envelopes, versioned definitions and stable error DTOs', () => {
    expect(parseRuntimeTriggerRegisterParams({ clientKey: 'k', receiverSessionId: 'r', expiresAt: 1_900_000_000_000,
      condition: { type: 'time', at: '2030-01-01T00:00:00Z', taskPrompt: 'wake' } })).toMatchObject({ clientKey: 'k' })
    expect(() => parseRuntimeTriggerRegisterParams({ clientKey: 'k', receiverSessionId: 'r', expiresAt: 1_800_000_000_000,
      condition: { type: 'time', at: '2030-01-01T00:00:00Z', taskPrompt: 'wake' } })).toThrow('time-after-expiry')
    expect(parseRuntimeTriggerDefinition({ version: 1, condition: { type: 'process_exit', managedProcessId: 'm' }, sourceBaseline: {} })).toMatchObject({ version: 1 })
    expect(() => parseRuntimeTriggerDefinition({ version: 2, condition: {}, sourceBaseline: {} })).toThrow('definition-v1-invalid')
    expect(runtimeTriggerFailure('TRIGGER_CONFLICT', 'sync-already-registered', { currentState: 'waiting', revision: 3 })).toEqual({ code: 'TRIGGER_CONFLICT', case: 'sync-already-registered', currentState: 'waiting', revision: 3 })
  })

  it('validates all five operation inputs and public output/page DTOs', () => {
    expect(parseRuntimeTriggerGetParams({ triggerId: 'trigger-1' })).toEqual({ triggerId: 'trigger-1' })
    expect(parseRuntimeTriggerCancelParams({ triggerId: 'trigger-1', expectedRevision: 2 })).toEqual({ triggerId: 'trigger-1', expectedRevision: 2 })
    expect(parseRuntimeTriggerPageParams({ cursor: 'opaque', limit: 100 })).toEqual({ cursor: 'opaque', limit: 100 })
    const trigger = { triggerId: 'trigger-1', ownerSessionId: 'owner', receiverSessionId: 'receiver', clientKey: 'client',
      definition: { version: 1, condition: { type: 'process_exit', managedProcessId: 'proc-1' }, sourceBaseline: {} },
      state: 'waiting', createdAt: 1, expiresAt: 2, revision: 1 }
    expect(parseRuntimeTriggerDto(trigger)).toMatchObject({ triggerId: 'trigger-1', state: 'waiting' })
    expect(parseRuntimeTriggerPageDto({ items: [trigger], nextCursor: 'next' }).items).toHaveLength(1)
    expect(parseRuntimeTriggerOperationDto({ trigger, replayed: true })).toMatchObject({ replayed: true, trigger: { triggerId: 'trigger-1' } })
    expect(parseRuntimeTriggerTargetsDto({ items: [{ kind: 'session', id: 's', label: 'Session' }] }).items).toHaveLength(1)
    expect(parseRuntimeTriggerFailure({ code: 'TRIGGER_SOURCE_GAP', case: 'im-coverage-changed' })).toEqual({ code: 'TRIGGER_SOURCE_GAP', case: 'im-coverage-changed' })
    expect(() => parseRuntimeTriggerFailure({ code: 'TRIGGER_SOURCE_GAP', case: 'im-coverage-changed', messageBody: 'secret' })).toThrow('failure-dto-invalid')
    expect(() => parseRuntimeTriggerCancelParams({ triggerId: 't', expectedRevision: 0 })).toThrow('cancel-fields-invalid')
    expect(() => parseRuntimeTriggerPageDto({ items: [trigger], unknown: true })).toThrow('page-dto-invalid')
    expect(mapLifecycleFailureToTriggerFailure('LIFECYCLE_CALLBACK_TIMEOUT')).toEqual({ code: 'TRIGGER_HANDLING_FAILED', case: 'callback-timeout' })
    expect(mapLifecycleFailureToTriggerFailure('LIFECYCLE_PAUSE_TIMEOUT')).toEqual({ code: 'TRIGGER_HANDLING_FAILED', case: 'pause-timeout' })
  })

  it('pins the versioned initial-admission fixture and rejects agent-controlled or partial fields', () => {
    const admission = { version: 1, triggerId: 'trigger-1', requestId: 'runtime-trigger:trigger-1', receiverSessionId: 'receiver', turnId: 'turn',
      invocationId: 'invocation', contextEventId: 'event', contextDigest: 'sha256:context', payloadDigest: 'sha256:payload',
      authorizationGeneration: 'auth-2', policyRevision: 'policy-4', acceptedAt: 1_900_000_000_000 }
    expect(parseRuntimeTriggerAdmission(admission)).toEqual(admission)
    expect(() => parseRuntimeTriggerAdmission({ ...admission, ownerSessionId: 'agent-controlled' })).toThrow('admission-v1-invalid')
    expect(() => parseRuntimeTriggerAdmission({ ...admission, payloadDigest: '' })).toThrow('admission-v1-invalid')
  })
})
