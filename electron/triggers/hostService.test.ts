import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { appendMessage, createPersistedTurn, createSession, enqueueAgentSessionMessageInScope, getPersistedTurn, updatePersistedTurnState } from '../database/operations'
import { createSessionCommands } from '../sessionStorage/commands'
import { createRuntimeTriggerHostService } from './hostService'
import { evaluateImInboundGuard } from '../remote/imInboundGuard'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import type { PolicyRule } from '../../src/shared/confirmation/types'
import { authorizeRuntimeTriggerImSource } from './imSourceAuthorization'

describe('runtime trigger host capability adapter', () => {
  it('registers an exact outgoing agent-session request wait in the owner session, even during an active Turn', async () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'message wait owner', workDirProfileId: 'message-wait-profile' })
      const foreignOwner = createSession(db, { name: 'foreign message wait owner', workDirProfileId: 'message-wait-profile' })
      const target = createSession(db, { name: 'message wait target', workDirProfileId: 'message-wait-profile' })
      const accepted = enqueueAgentSessionMessageInScope(db, { ownerSessionId: owner.id, targetSessionId: target.id,
        requestId: `${owner.id}:message-wait-request`, content: 'not read by wait registration', authorizationBinding: {} })
      const assistant = appendMessage(db, { id: 'message-wait-active-assistant', sessionId: owner.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
      createPersistedTurn(db, { turnId: 'message-wait-active-turn', requestId: 'message-wait-active-request', sessionId: owner.id,
        assistantMessageId: assistant.message.id, state: 'executing' })
      const commands = createSessionCommands(db)
      const service = createRuntimeTriggerHostService({ commands,
        queries: { listSessions: () => [owner, foreignOwner, target], imAcceptedFacts: {} } as never,
        execution: { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }), readTurn: ({ sessionId, turnId }: { sessionId: string; turnId: string }) => {
          const turn = getPersistedTurn(db, turnId)
          return turn?.sessionId === sessionId ? turn : undefined
        } } as never })
      const params = { clientKey: 'wait-for-agent-session-message', receiverSessionId: owner.id, expiresAt: Date.now() + 60_000,
        condition: { type: 'agent_session_message', requestId: accepted.receipt.requestId } }

      await expect(service.register({ ownerSessionId: owner.id, params })).resolves.toMatchObject({
        trigger: { state: 'waiting', receiverSessionId: owner.id, definition: { condition: params.condition } }
      })
      await expect(service.register({ ownerSessionId: owner.id, params: { ...params, clientKey: 'unknown-request',
        condition: { ...params.condition, requestId: `${owner.id}:unknown` } } }))
        .rejects.toMatchObject({ failure: { code: 'TRIGGER_NOT_FOUND_OR_FORBIDDEN' } })
      await expect(service.register({ ownerSessionId: owner.id, params: { ...params, clientKey: 'wrong-receiver', receiverSessionId: target.id } }))
        .rejects.toMatchObject({ failure: { code: 'TRIGGER_NOT_FOUND_OR_FORBIDDEN' } })
      await expect(service.register({ ownerSessionId: foreignOwner.id, params: { ...params, clientKey: 'cross-owner', receiverSessionId: foreignOwner.id } }))
        .rejects.toMatchObject({ failure: { code: 'TRIGGER_NOT_FOUND_OR_FORBIDDEN' } })
    } finally { db.close() }
  })

  it('rejects stale or foreign Turn registrations but preserves a prior idempotent registration', async () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'turn owner', workDirProfileId: 'turn-profile' })
      const receiver = createSession(db, { name: 'turn receiver', workDirProfileId: 'turn-profile' })
      const foreign = createSession(db, { name: 'foreign turn', workDirProfileId: 'turn-profile' })
      const assistant = appendMessage(db, { id: 'turn-registration-assistant', sessionId: owner.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
      createPersistedTurn(db, { turnId: 'registered-turn', requestId: 'registered-turn-request', sessionId: owner.id,
        assistantMessageId: assistant.message.id, state: 'executing' })
      const commands = createSessionCommands(db)
      const sessions = [owner, receiver, foreign]
      const service = createRuntimeTriggerHostService({ commands,
        queries: { listSessions: () => sessions, imAcceptedFacts: {} } as never,
        execution: { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }),
          readTurn: ({ sessionId, turnId }: { sessionId: string; turnId: string }) => {
            const turn = getPersistedTurn(db, turnId)
            return turn?.sessionId === sessionId ? turn : undefined
          } } as never })
      const params = { clientKey: 'active-turn', receiverSessionId: receiver.id, expiresAt: Date.now() + 60_000,
        condition: { type: 'turn_completed', targetSessionId: owner.id, turnId: 'registered-turn' } }
      await expect(service.register({ ownerSessionId: owner.id, params })).resolves.toMatchObject({ trigger: { state: 'waiting' } })
      updatePersistedTurnState(db, 'registered-turn', 'terminal', { outcome: 'completed' })
      await expect(service.register({ ownerSessionId: owner.id, params })).resolves.toMatchObject({ replayed: true })
      await expect(service.register({ ownerSessionId: owner.id, params: { ...params, clientKey: 'after-terminal' } }))
        .rejects.toThrow('TRIGGER_CONFLICT:target-turn-not-active')
      await expect(service.register({ ownerSessionId: owner.id, params: { ...params, clientKey: 'missing-turn',
        condition: { ...params.condition, turnId: 'missing-turn' } } })).rejects.toThrow('TRIGGER_CONFLICT:target-turn-not-active')
      const foreignAssistant = appendMessage(db, { id: 'foreign-turn-assistant', sessionId: foreign.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
      createPersistedTurn(db, { turnId: 'foreign-turn', requestId: 'foreign-turn-request', sessionId: foreign.id,
        assistantMessageId: foreignAssistant.message.id, state: 'executing' })
      await expect(service.register({ ownerSessionId: owner.id, params: { ...params, clientKey: 'foreign-turn',
        condition: { ...params.condition, turnId: 'foreign-turn' } } })).rejects.toThrow('TRIGGER_CONFLICT:target-turn-not-active')
    } finally { db.close() }
  })

  it('rejects a Turn that terminates while registration waits for its baseline', async () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'racing turn owner', workDirProfileId: 'race-profile' })
      const receiver = createSession(db, { name: 'racing turn receiver', workDirProfileId: 'race-profile' })
      const assistant = appendMessage(db, { id: 'racing-turn-assistant', sessionId: owner.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
      createPersistedTurn(db, { turnId: 'racing-turn', requestId: 'racing-turn-request', sessionId: owner.id,
        assistantMessageId: assistant.message.id, state: 'executing' })
      let reads = 0
      const execution = { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }), readTurn: ({ sessionId, turnId }: { sessionId: string; turnId: string }) => {
        reads += 1
        if (reads === 1) updatePersistedTurnState(db, 'racing-turn', 'terminal', { outcome: 'completed' })
        const turn = getPersistedTurn(db, turnId)
        return turn?.sessionId === sessionId ? turn : undefined
      } }
      const service = createRuntimeTriggerHostService({ commands: createSessionCommands(db), queries: { listSessions: () => [owner, receiver], imAcceptedFacts: {} } as never,
        execution: execution as never })
      await expect(service.register({ ownerSessionId: owner.id, params: { clientKey: 'turn-race', receiverSessionId: receiver.id, expiresAt: Date.now() + 60_000,
        condition: { type: 'turn_completed', targetSessionId: owner.id, turnId: 'racing-turn' } } })).rejects.toThrow('TRIGGER_CONFLICT:target-turn-not-active')
    } finally { db.close() }
  })

  it('captures a settled baseline for each existing invocation at registration', async () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'step baseline owner' })
      const invocationIds = ['old-invocation-a', 'old-invocation-b']
      const execution = { historyFor: () => ({ listInvocationIds: () => invocationIds, read: async (invocationId: string) => ({
        invocationId, version: 1, schemaVersion: 1, events: [{ eventId: `${invocationId}:response`, idempotencyKey: `${invocationId}:key`,
          invocationId, turnId: `${invocationId}:turn`, sequence: 1, schemaVersion: 1, kind: 'model-response-committed',
          payload: { modelTurn: 1, message: { role: 'assistant', toolCalls: [] } } }]
      }) }) }
      const service = createRuntimeTriggerHostService({ commands: createSessionCommands(db),
        queries: { listSessions: () => [owner], imAcceptedFacts: {} } as never, execution: execution as never })
      const result = await service.register({ ownerSessionId: owner.id, params: { clientKey: 'cross-invocation-baseline', receiverSessionId: owner.id,
        expiresAt: Date.now() + 60_000, condition: { type: 'session_steps', targetSessionId: owner.id, origin: 'registration', threshold: 1, mode: 'async' } } })
      expect(result.trigger.definition.sourceBaseline).toEqual({ settledCount: 2, settledCountByInvocation: { 'old-invocation-a': 1, 'old-invocation-b': 1 } })
    } finally { db.close() }
  })

  it('rejects new registrations once application shutdown has closed admission', async () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'shutting-down owner' })
      const service = createRuntimeTriggerHostService({ commands: createSessionCommands(db),
        queries: { listSessions: () => [owner], imAcceptedFacts: {} } as never,
        execution: { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }) } as never,
        accepting: () => false })
      await expect(service.register({ ownerSessionId: owner.id, params: { clientKey: 'late-admission', receiverSessionId: owner.id,
        expiresAt: Date.now() + 60_000, condition: { type: 'time', at: new Date(Date.now() + 30_000).toISOString(), taskPrompt: 'wake' } } }))
        .rejects.toThrow('TRIGGER_ADMISSION_CLOSED')
    } finally { db.close() }
  })

  it('filters targets to visible sessions in the owner work profile and owned processes', async () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'owner', workDirProfileId: 'profile-a' })
      const peer = createSession(db, { name: 'peer', workDirProfileId: 'profile-a' })
      createSession(db, { name: 'other profile', workDirProfileId: 'profile-b' })
      const hidden = createSession(db, { name: 'hidden', workDirProfileId: 'profile-a', ownership: 'internal', visibility: 'hidden' })
      const listProcesses = vi.fn((sessionId: string) => sessionId === owner.id ? [{ kind: 'managed-process' as const, id: 'proc-owned', label: 'run_shell' }] : [])
      const queries = { listSessions: () => [owner, peer], imAcceptedFacts: {} }
      const service = createRuntimeTriggerHostService({ commands: createSessionCommands(db), queries: queries as never,
        execution: { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }) } as never,
        listProcesses, processGeneration: () => 'generation-1' })
      expect(service.targets({ ownerSessionId: owner.id, params: {} }).items.map(({ id }) => id)).toEqual([owner.id, peer.id, 'proc-owned'])
      await expect(service.register({ ownerSessionId: owner.id, params: { clientKey: 'hidden-target', receiverSessionId: hidden.id,
        expiresAt: Date.now() + 10_000, condition: { type: 'time', at: new Date(Date.now() + 1_000).toISOString(), taskPrompt: 'wake' } } }))
        .rejects.toMatchObject({ failure: { code: 'TRIGGER_NOT_FOUND_OR_FORBIDDEN' } })
    } finally { db.close() }
  })

  it('binds IM source registration to the owner conversation and existing accepted account facts', async () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'remote owner', workDirProfileId: 'profile-a', metadata: { source: 'wechat', wechatMeta: { userId: 'alice' } } })
      let through = 0
      const queries = { listSessions: () => [owner], imAcceptedFacts: { captureFrontier: ({ accountId, conversationId }: { accountId: string; conversationId: string }) => ({
        through: accountId === 'account-a' && conversationId === 'alice' ? through : 0, coverageRevision: 1
      }) } }
      const service = createRuntimeTriggerHostService({ commands: createSessionCommands(db), queries: queries as never,
        execution: { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }) } as never,
        authorizeImSource: ({ senderId }) => {
          const guard = evaluateImInboundGuard({ channel: 'wechat', senderId, getConfig: () => ({ enabled: true, remoteEnabled: true, loggedIn: true, remoteSenderAllowlist: ['alice'] }),
            getPolicyRules: () => [] })
          return guard.ok ? { allowed: true, policyTrace: { ruleId: guard.snapshot.ingressDecision?.ruleId, policyRevision: 'test-policy' } } : { allowed: false }
        } })
      const params = { clientKey: 'im-trigger', receiverSessionId: owner.id, expiresAt: Date.now() + 60_000,
        condition: { type: 'im_message', channel: 'wechat', accountId: 'account-a', conversationId: 'alice' } }
      await expect(service.register({ ownerSessionId: owner.id, params })).rejects.toMatchObject({ failure: { code: 'TRIGGER_NOT_FOUND_OR_FORBIDDEN' } })
      through = 1
      await expect(service.register({ ownerSessionId: owner.id, params })).resolves.toMatchObject({ trigger: { state: 'waiting', definition: { sourceBaseline: { through: 1, coverageRevision: 1 } } } })
    } finally { db.close() }
  })

  it('rechecks the current IM channel, account and exact sender policy against matched history facts', () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'live IM authorization', metadata: { source: 'wechat', wechatMeta: { userId: 'alice' } } })
      let remoteEnabled = true
      let allowedSenders = ['alice']
      let through = 1
      const queries = { listSessions: () => [owner], imAcceptedFacts: { captureFrontier: () => ({ through, coverageRevision: 7 }) } }
      const service = createRuntimeTriggerHostService({ commands: createSessionCommands(db), queries: queries as never,
        execution: { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }) } as never,
        authorizeImSource: ({ channel, accountId, conversationId, senderId }) => {
          const guard = evaluateImInboundGuard({ channel, senderId,
            getConfig: () => ({ enabled: true, remoteEnabled, loggedIn: true, remoteSenderAllowlist: allowedSenders }), getPolicyRules: () => [] })
          return guard.ok && allowedSenders.includes(senderId) && accountId === 'alice' && conversationId === 'alice'
            ? { allowed: true, policyTrace: { ruleId: guard.snapshot.ingressDecision?.ruleId, policyRevision: 'policy-r7' } }
            : { allowed: false }
        } })
      const condition = { type: 'im_message' as const, channel: 'wechat' as const, accountId: 'alice', conversationId: 'alice' }
      const event = { type: 'im_message', channel: 'wechat', accountId: 'alice', conversationId: 'alice', senderId: 'alice', isGroup: false, occurredAt: 10 }
      expect(service.authorizeSource(owner.id, owner.id, condition, {}, event)).toMatchObject({ allowed: true, policyTrace: [{ ruleId: 'ingress-default-allow' }] })
      remoteEnabled = false
      expect(service.authorizeSource(owner.id, owner.id, condition, {}, event)).toMatchObject({ allowed: false })
      remoteEnabled = true
      allowedSenders = []
      expect(service.authorizeSource(owner.id, owner.id, condition, {}, event)).toMatchObject({ allowed: false })
      allowedSenders = ['alice']
      expect(service.authorizeSource(owner.id, owner.id, condition, {}, { ...event, senderId: 'mallory' })).toMatchObject({ allowed: false })
      through = 2
      expect(service.authorizeSource(owner.id, owner.id, condition, {}, event)).toMatchObject({ allowed: true })
    } finally { db.close() }
  })

  it('reauthorizes exact Feishu group facts and honors current direct-other ingress policy', () => {
    const db = createMemoryAppDb()
    try {
      const groupOwner = createSession(db, { name: 'group owner', metadata: { source: 'feishu', feishuChatId: 'group-1',
        feishuSenderOpenId: 'alice', feishuChatType: 'group' } })
      const externalOwner = createSession(db, { name: 'external owner', metadata: { source: 'feishu', feishuChatId: 'chat-external',
        feishuSenderOpenId: 'external', feishuChatType: 'p2p' } })
      let remoteEnabled = true
      let allowlist = ['alice']
      let rules: PolicyRule[] = DEFAULT_POLICY_RULES.map((rule) => ({ ...rule }))
      const authorizeImSource = (source: Parameters<typeof authorizeRuntimeTriggerImSource>[0]['source']) => authorizeRuntimeTriggerImSource({ source,
        config: { enabled: true, ready: true, remoteEnabled, loggedIn: true, remoteSenderAllowlist: allowlist },
        policyRules: rules, policyRevision: 'current-policy', authorizationGeneration: 'current-auth-generation' })
      const service = createRuntimeTriggerHostService({ commands: createSessionCommands(db),
        queries: { listSessions: () => [groupOwner, externalOwner], imAcceptedFacts: { captureFrontier: () => ({ through: 1, coverageRevision: 1 }) } } as never,
        execution: { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }) } as never, authorizeImSource })
      const groupCondition = { type: 'im_message' as const, channel: 'feishu' as const, accountId: 'alice', conversationId: 'group-1' }
      const groupEvent = { type: 'im_message', channel: 'feishu', accountId: 'alice', conversationId: 'group-1', senderId: 'alice', isGroup: true, occurredAt: 1 }
      expect(service.authorizeSource(groupOwner.id, groupOwner.id, groupCondition, {}, groupEvent)).toMatchObject({ allowed: false })
      rules = rules.map((rule) => rule.id === 'ingress-feishu-group-deny' ? { ...rule, action: 'allow' } : rule)
      expect(service.authorizeSource(groupOwner.id, groupOwner.id, groupCondition, {}, groupEvent))
        .toMatchObject({ allowed: true, policyTrace: [{ originKind: 'group', ruleId: 'ingress-feishu-group-deny', action: 'allow' }] })
      rules = rules.map((rule) => rule.id === 'ingress-feishu-group-deny' ? { ...rule, action: 'deny' } : rule)
      expect(service.authorizeSource(groupOwner.id, groupOwner.id, groupCondition, {}, groupEvent)).toMatchObject({ allowed: false })
      expect(service.authorizeSource(groupOwner.id, groupOwner.id, groupCondition, {}, { ...groupEvent, isGroup: undefined })).toMatchObject({ allowed: false })
      expect(service.authorizeSource(groupOwner.id, groupOwner.id, groupCondition, {}, { ...groupEvent, isGroup: false }))
        .toMatchObject({ allowed: true, policyTrace: [{ originKind: 'direct-owner' }] })

      const externalCondition = { type: 'im_message' as const, channel: 'feishu' as const, accountId: 'external', conversationId: 'chat-external' }
      const externalEvent = { type: 'im_message', channel: 'feishu', accountId: 'external', conversationId: 'chat-external', senderId: 'external', isGroup: false, occurredAt: 2 }
      rules = rules.map((rule) => rule.id === 'ingress-direct-other-deny' ? { ...rule, action: 'allow' } : rule)
      expect(service.authorizeSource(externalOwner.id, externalOwner.id, externalCondition, {}, externalEvent))
        .toMatchObject({ allowed: true, policyTrace: [{ originKind: 'direct-other', ruleId: 'ingress-direct-other-deny', action: 'allow' }] })
      rules = rules.map((rule) => rule.id === 'ingress-direct-other-deny' ? { ...rule, action: 'ask' } : rule)
      expect(service.authorizeSource(externalOwner.id, externalOwner.id, externalCondition, {}, externalEvent)).toMatchObject({ allowed: false })
      rules = rules.map((rule) => rule.id === 'ingress-direct-other-deny' ? { ...rule, action: 'deny' } : rule)
      expect(service.authorizeSource(externalOwner.id, externalOwner.id, externalCondition, {}, externalEvent)).toMatchObject({ allowed: false })
      remoteEnabled = false
      allowlist = []
      expect(service.authorizeSource(externalOwner.id, externalOwner.id, externalCondition, {}, externalEvent)).toMatchObject({ allowed: false })
    } finally { db.close() }
  })
})
