import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { createDeferredEnvelopeStore } from './deferredEnvelopeStore'

const contentVersions = { document: 3, attachment: 1 }
const executionContext = { workDir: '/workspace/project', sessionId: 'origin-1', channel: 'feishu' as const }
const canonicalArgs = { path: 'notes/plan.md', content: 'approved bytes' }

describe('deferred immutable call envelope', () => {
  it('rebinds only policy authorization metadata and recomputes envelope integrity', () => {
    const db = createMemoryAppDb()
    const store = createDeferredEnvelopeStore(db)
    const args = { recipient: 'peer', text: 'hello' }
    const versions = { taskRevision: 1 }
    const context = { toolName: 'wechat_send', toolInput: { recipient: 'peer', text: 'hello' }, ruleId: 'old-rule', factsHash: 'old-facts',
      policyBehaviorVersion: 'im-standard-v2', policyRevision: 1, policyEpoch: 1, confirmationReceipt: 'old-receipt' }
    const original = store.put({ invocationId: 'policy-rebind', requestId: 'request', turnId: 'turn', toolCallId: 'call',
      toolName: 'wechat_send', canonicalArgs: args, contentVersions: versions, executionContext: context })

    const updated = store.updatePolicy('policy-rebind', { ruleId: 'new-rule', factsHash: 'new-facts',
      policyBehaviorVersion: 'im-standard-v2', policyRevision: 2, policyEpoch: 2, confirmationReceipt: 'new-receipt' })

    expect(updated).toMatchObject({ invocationId: original.invocationId, toolName: original.toolName,
      canonicalArgs: original.canonicalArgs, contentVersions: original.contentVersions,
      executionContext: { ruleId: 'new-rule', factsHash: 'new-facts', policyRevision: 2, policyEpoch: 2,
        confirmationReceipt: 'new-receipt' } })
    expect(store.get('policy-rebind')).toEqual(updated)
    expect(store.verify(updated!, { requestId: 'request', turnId: 'turn', toolCallId: 'call', toolName: 'wechat_send',
      canonicalArgs: args, contentVersions: versions, executionContext: updated!.executionContext })).toEqual({ ok: true })
    db.close()
  })

  it('binds canonical args, content versions, execution context, and format versions', () => {
    const db = createMemoryAppDb()
    const store = createDeferredEnvelopeStore(db)
    const envelope = store.put({ invocationId: 'invocation-envelope-1', requestId: 'request-envelope-1', turnId: 'turn-envelope-1',
      toolCallId: 'tool-call-envelope-1', toolName: 'write_file', canonicalArgs, contentVersions, executionContext })

    expect(envelope).toMatchObject({
      invocationId: 'invocation-envelope-1', requestId: 'request-envelope-1', turnId: 'turn-envelope-1', toolCallId: 'tool-call-envelope-1',
      schemaVersion: 2, canonicalizationVersion: 'canonical-json-v1',
      canonicalArgsHash: expect.any(String), contentVersions, executionContextHash: expect.any(String)
    })
    expect(store.verify(envelope, { requestId: 'request-envelope-1', turnId: 'turn-envelope-1', toolCallId: 'tool-call-envelope-1',
      toolName: 'write_file', canonicalArgs, contentVersions, executionContext })).toEqual({ ok: true })
    expect(store.verify(envelope, { requestId: 'substituted-request', turnId: 'turn-envelope-1', toolCallId: 'tool-call-envelope-1',
      toolName: 'write_file', canonicalArgs, contentVersions, executionContext })).toEqual({ ok: false, reason: 'call_changed' })
    expect(store.verify(envelope, { toolName: 'write_file', canonicalArgs: { ...canonicalArgs, content: 'changed bytes' }, contentVersions, executionContext })).toMatchObject({ ok: false })
    expect(store.verify(envelope, { toolName: 'write_file', canonicalArgs, contentVersions: { document: 4, attachment: 1 }, executionContext })).toMatchObject({ ok: false })
    expect(store.verify(envelope, { toolName: 'write_file', canonicalArgs, contentVersions, executionContext: { ...executionContext, workDir: '/workspace/other' } })).toMatchObject({ ok: false })
    expect(store.verify(envelope, { toolName: 'write_file', canonicalArgs, contentVersions,
      executionContext: { ...executionContext, evidenceReferences: ['host-fact:substituted'] } }))
      .toEqual({ ok: false, reason: 'context_changed' })
    db.close()
  })

  it('snapshots mutable inputs and rejects missing, damaged, unsupported, or tampered envelopes', () => {
    const db = createMemoryAppDb()
    const store = createDeferredEnvelopeStore(db)
    const mutableArgs = { ...canonicalArgs }
    const mutableVersions = { ...contentVersions }
    const envelope = store.put({
      invocationId: 'invocation-envelope-2', toolName: 'write_file',
      canonicalArgs: mutableArgs, contentVersions: mutableVersions, executionContext
    })
    mutableArgs.content = 'mutated after preparation'
    mutableVersions.document = 99
    expect(store.get(envelope.invocationId)?.canonicalArgs).toEqual(canonicalArgs)
    expect(store.get('missing-envelope')).toBeNull()

    const conn = getDbConnection(db)
    conn.prepare("UPDATE deferred_call_envelopes SET envelope_json='not-json' WHERE invocation_id=?").run(envelope.invocationId)
    expect(store.get(envelope.invocationId)).toBeNull()
    expect(() => store.verify({ ...envelope, schemaVersion: 999 }, { canonicalArgs, contentVersions, executionContext }))
      .toThrow(/UNSUPPORTED_ENVELOPE_SCHEMA/)
    db.close()
  })

  it('rejects rebuilding one deferred step under a fresh invocation or a substituted tool', () => {
    const db = createMemoryAppDb()
    const store = createDeferredEnvelopeStore(db)
    const original = store.put({ invocationId: 'workflow-1:step-publish', toolName: 'wechat_send', canonicalArgs,
      contentVersions, executionContext: { ...executionContext, workflowId: 'workflow-1', stepId: 'publish' } })
    expect(() => store.put({ invocationId: 'workflow-1:step-publish', toolName: 'write_file', canonicalArgs,
      contentVersions, executionContext: { ...executionContext, workflowId: 'workflow-1', stepId: 'publish' } })).toThrow('INVOCATION_ENVELOPE_CONFLICT')
    expect(store.verify(original, { toolName: 'wechat_send', canonicalArgs: { ...canonicalArgs, content: 'changed' }, contentVersions, executionContext: { ...executionContext, workflowId: 'workflow-1', stepId: 'publish' } }))
      .toMatchObject({ ok: false, reason: 'args_changed' })
    expect(store.verify(original, { toolName: 'write_file', canonicalArgs, contentVersions, executionContext: { ...executionContext, workflowId: 'workflow-1', stepId: 'publish' } }))
      .toMatchObject({ ok: false, reason: 'tool_changed' })
    expect(store.get('workflow-1:step-publish')).toMatchObject({ toolName: 'wechat_send', integrityHash: original.integrityHash })
    db.close()
  })
})
