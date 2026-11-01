import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runAgentTurn } from '../../packages/agent-sdk/src/turn'
import { ModelProviderRegistry, type CanonicalModelMessage } from '../../packages/agent-sdk/src/model'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { createAgentSdkSafetyPolicy } from '../confirmation/agentSdkSafetyPolicy'
import { createPermitBoundToolExecutionPort } from '../../packages/agent-sdk/src/toolExecutionPort'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection, openDatabase } from '../database'
import { appendMessage, createSession } from '../database/operations'
import { commitSessionTranscript, readSessionTranscript } from '../database/sessionTranscript'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { createSpillStore } from '../storage/spillStore'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { getProjectedMessages } from '../sessionStorage/infrastructure/sqlite/sessionTranscriptProjection'
import { restoreLegacySessionContextSnapshot, restoreSessionContext, type SessionContextState } from '../../packages/agent-sdk/src/sessionContext'
import type { PermitBinding } from '../../packages/agent-sdk/src/safetyPermit'

const route = { routeId: 'session-context-replay', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }

function createToolExecutionPort() {
  return createPermitBoundToolExecutionPort({
    permits: new InMemorySafetyPermitStore(), admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
    resolveExpected: async (call) => ({ requestId: 'request', turnId: call.invocationId, invocationId: call.invocationId,
      toolCallId: call.toolCallId, capabilityId: call.toolName, inputSnapshotHash: 'hash', planDigest: 'plan', factsDigest: 'facts',
      authorizationVersion: 'auth', phase: 'recheck' }),
    execute: async () => ({ output: 'unused' })
  })
}

const toolBinding: PermitBinding = { requestId: 'req', turnId: 'turn', invocationId: 'inv', toolCallId: 'tc1', capabilityId: 'lookup',
  inputSnapshotHash: 'input-hash', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'auth-v1', phase: 'initial-compat' }

describe('SDK session context SQLite replay contract', () => {
  it('keeps warm and cold context equal across SDK-written success, failure, reopen, and next turns', async () => {
    const temp = createTempDatabase('session-context-replay-')
    let db = temp.db
    const session = createSession(db, { name: 'context-replay', model: 'test' })
    const registry = new ModelProviderRegistry()
    let providerCall = 0
    registry.register(route, { providerId: 'context-replay-provider', stream: async function* (call) {
      providerCall += 1
      if (providerCall === 2) throw new Error('deterministic provider failure')
      const lastUser = [...call.request.messages].reverse().find((message) => message.role === 'user')
      yield { type: 'text-delta', text: `answer-${String(lastUser?.content)}` }
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish', reason: 'stop' }
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('unused', [])
    const safetyGate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy: createAgentSdkSafetyPolicy() })
    const invoke = async (turn: number, currentDb: typeof db, prior?: SessionContextState) => {
      const user: CanonicalModelMessage = { role: 'user', id: `user-${turn}`, content: `q${turn}` }
      const messages = [...(prior?.committed ?? []), user]
      let committed: SessionContextState | undefined
      const history = new SqliteAgentHistory(getDbConnection(currentDb), 1, Date.now, session.id)
      const input = {
        registry, routeId: route.routeId, invocationId: `invocation-${turn}`, turnId: `turn-${turn}`, sessionId: session.id,
        sessionTranscriptBaseVersion: turn - 1, sessionTranscriptCommitProtocol: 2 as const,
        ...(prior ? { sessionContext: prior, sessionContextInputMessages: [user], sessionContextFailureInputMessages: [user] } : {}),
        onSessionContextCommitted: (state: SessionContextState) => { committed = state }, history,
        request: { messages, maxTokens: 32 }, maxModelTurns: 1,
        safetyGate, prepareTool: async () => { throw new Error('tools are unused in this test') },
        toolExecution: createToolExecutionPort()
      }
      if (turn === 2) await expect(runAgentTurn(input)).rejects.toThrow('deterministic provider failure')
      else await runAgentTurn(input)
      const replayed = readSessionTranscript(currentDb, session.id)
      expect(replayed.version).toBe(turn)
      expect(committed).toBeDefined()
      expect(replayed.messages).toEqual(committed!.committed)
      return committed!
    }

    try {
      let warm = await invoke(1, db)
      warm = await invoke(2, db, warm)
      db.close()
      db = openDatabase(temp.dbPath)
      const afterReopen = readSessionTranscript(db, session.id)
      expect(afterReopen.messages).toEqual(warm.committed)
      warm = await invoke(3, db, warm)
      expect(warm.committed.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['q1', 'q2', 'q3'])
      expect(warm.committed.filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual(['answer-q1', 'answer-q3'])
    } finally {
      temp.cleanup(db)
    }
  })

  it('persists actual SDK multi-tool results once in declaration order and replays them after reopen', async () => {
    const temp = createTempDatabase('session-context-tools-replay-')
    let db = temp.db
    const session = createSession(db, { name: 'context-tools-replay', model: 'test' })
    const registry = new ModelProviderRegistry()
    let modelTurn = 0
    registry.register(route, { providerId: 'multi-tool-replay-provider', stream: async function* () {
      modelTurn += 1
      if (modelTurn === 1) {
        yield { type: 'tool-call', toolCallId: 'tool-a', toolName: 'lookup', input: { order: 1 } }
        yield { type: 'tool-call', toolCallId: 'tool-b', toolName: 'lookup', input: { order: 2 } }
        yield { type: 'tool-call', toolCallId: 'tool-c', toolName: 'lookup', input: { order: 3 } }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text-delta', text: 'all tools summarized' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    } })
    const permits = new InMemorySafetyPermitStore()
    const capabilities = new CapabilityRegistry()
    capabilities.define('multi-tool-invocation', ['lookup'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits,
      policy: { evaluate: async (binding) => binding.toolCallId === 'tool-a' && binding.phase === 'initial-compat'
        ? { kind: 'ask' as const, confirmationId: 'approve-tool-a', answerer: 'user' as const, reasonCode: 'USER_APPROVAL' }
        : { kind: 'allow' as const, authorizationVersion: 'auth-v1' } } })
    const toolExecution = createPermitBoundToolExecutionPort({ permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
      resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
      execute: async (call) => ({ output: `result-${call.toolCallId}` }) })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    let context: SessionContextState | undefined

    try {
      await runAgentTurn({ registry, routeId: route.routeId, invocationId: 'multi-tool-invocation', turnId: 'multi-tool-turn', sessionId: session.id,
        history, request: { messages: [{ role: 'user', id: 'user-tools', content: 'run tools' }], maxTokens: 32 },
        sessionTranscriptBaseVersion: 0, sessionTranscriptCommitProtocol: 2, maxModelTurns: 2, safetyGate,
        prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName,
          phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
        toolExecution, confirmation: async () => ({ kind: 'approved', receipt: 'approved-tool-a', answerer: 'user' }),
        onSessionContextCommitted: (next) => { context = next } })
      const warm = context!.committed
      const warmToolResults = warm.filter((message) => message.role === 'tool')
      expect(warmToolResults).toMatchObject([
        { role: 'tool', toolCallId: 'tool-a', content: 'result-tool-a' },
        { role: 'tool', toolCallId: 'tool-b', content: 'result-tool-b' },
        { role: 'tool', toolCallId: 'tool-c', content: 'result-tool-c' }
      ])
      expect(warmToolResults).toHaveLength(3)
      expect((await history.read('multi-tool-invocation')).events).toContainEqual(expect.objectContaining({
        kind: 'approval-resolved', payload: expect.objectContaining({ toolCallId: 'tool-a', approved: true, answerer: 'user' })
      }))
      expect(context!.pendingTools.size).toBe(0)
      expect(context!.completedToolResults.size).toBe(0)
      expect(readSessionTranscript(db, session.id).messages).toEqual(warm)
      db.close()
      db = openDatabase(temp.dbPath)
      expect(readSessionTranscript(db, session.id).messages).toEqual(warm)
    } finally {
      temp.cleanup(db)
    }
  })

  it('replays a model-visible result when dispatch is rejected before execution', async () => {
    const temp = createTempDatabase('session-context-rejected-tool-replay-')
    let db = temp.db
    const session = createSession(db, { name: 'rejected-tool-replay', model: 'test' })
    appendMessage(db, { id: 'rejected-user', sessionId: session.id, role: 'user', content: 'try lookup', timestamp: 1, status: 'sent' })
    const registry = new ModelProviderRegistry()
    let modelTurn = 0
    registry.register(route, { providerId: 'rejected-tool-provider', stream: async function* () {
      modelTurn += 1
      if (modelTurn === 1) {
        yield { type: 'tool-call', toolCallId: 'rejected-call', toolName: 'lookup', input: {} }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text-delta', text: 'rejection understood' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('rejected-invocation', ['lookup'])
    let warm: SessionContextState | undefined
    try {
      const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
      await runAgentTurn({ registry, routeId: route.routeId, invocationId: 'rejected-invocation', turnId: 'rejected-turn', sessionId: session.id,
        history, request: { messages: [{ role: 'user', id: 'rejected-user', content: 'try lookup', timestamp: 1 }], maxTokens: 32 },
        sessionTranscriptBaseVersion: 0, sessionTranscriptCommitProtocol: 2, maxModelTurns: 2,
        safetyGate: new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy: createAgentSdkSafetyPolicy() }),
        prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId,
          capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
        toolExecution: createToolExecutionPort(), beforeToolDispatch: async () => ({ kind: 'reject', reasonCode: 'TEST_REJECT', message: 'lookup blocked' }),
        onSessionContextCommitted: (state) => { warm = state } })
      expect(warm?.committed.filter((message) => message.role === 'tool')).toEqual([
        { role: 'tool', toolCallId: 'rejected-call', content: 'lookup blocked', isError: true }
      ])
      expect(readSessionTranscript(db, session.id).messages).toEqual(warm?.committed)
      const committedVersion = readSessionTranscript(db, session.id).version
      const historyEvents = (await history.read('rejected-invocation')).events
      expect(restoreSessionContext({ committedVersion, events: historyEvents }).committed).toEqual(warm?.committed)
      const shadow = history.readCanonicalSessionTranscriptForShadow(session.id)
      if (shadow.kind !== 'matched') throw new Error(`canonical transcript shadow unavailable: ${shadow.reason}`)
      expect(shadow.messages.some((message) => message.role === 'tool')).toBe(false)
      getDbConnection(db).prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      getDbConnection(db).prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id='rejected-user'").run()
      expect(getProjectedMessages(db, session.id).find(({ id }) => id === 'rejected-user')?.content).toBe('try lookup')
      db.close()
      db = openDatabase(temp.dbPath)
      expect(readSessionTranscript(db, session.id).messages).toEqual(warm?.committed)
      expect(restoreSessionContext({ committedVersion, events: (await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
        .read('rejected-invocation')).events }).committed).toEqual(warm?.committed)
    } finally {
      temp.cleanup(db)
    }
  })

  it('persists the tool result from output-limit recovery before the continuation message', async () => {
    const temp = createTempDatabase('session-context-output-limit-tool-replay-')
    let db = temp.db
    const session = createSession(db, { name: 'output-limit-tool-replay', model: 'test' })
    const registry = new ModelProviderRegistry()
    let modelTurn = 0
    registry.register(route, { providerId: 'output-limit-tool-provider', stream: async function* () {
      modelTurn += 1
      if (modelTurn === 1) {
        yield { type: 'tool-call', toolCallId: 'truncated-call', toolName: 'lookup', input: {} }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'length' }
      } else {
        yield { type: 'text-delta', text: 'truncation understood' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    } })
    const capabilities = new CapabilityRegistry()
    let warm: SessionContextState | undefined
    try {
      const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
      await runAgentTurn({ registry, routeId: route.routeId, invocationId: 'output-limit-invocation', turnId: 'output-limit-turn', sessionId: session.id,
        history, request: { messages: [{ role: 'user', id: 'output-limit-user', content: 'try lookup' }], maxTokens: 32 },
        sessionTranscriptBaseVersion: 0, sessionTranscriptCommitProtocol: 2, maxModelTurns: 2,
        recoverOutputLimit: async () => ({ continuation: { role: 'user', content: 'retry the complete call' } }),
        safetyGate: new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy: createAgentSdkSafetyPolicy() }),
        prepareTool: async () => { throw new Error('truncated tools are not dispatched') }, toolExecution: createToolExecutionPort(),
        onSessionContextCommitted: (state) => { warm = state } })
      expect(warm?.committed.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant'])
      const version = readSessionTranscript(db, session.id).version
      const outputLimitEvents = (await history.read('output-limit-invocation')).events
      expect(restoreSessionContext({ committedVersion: version, events: outputLimitEvents }).committed).toEqual(warm?.committed)
      const shadow = history.readCanonicalSessionTranscriptForShadow(session.id)
      if (shadow.kind !== 'matched') throw new Error(`output-limit canonical shadow unavailable: ${shadow.reason}`)
      if (shadow.kind === 'matched') expect(shadow.messages.some((message) => message.role === 'tool')).toBe(false)
      db.close()
      db = openDatabase(temp.dbPath)
      const reopened = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
      expect(restoreSessionContext({ committedVersion: version, events: (await reopened.read('output-limit-invocation')).events }).committed).toEqual(warm?.committed)
      expect(readSessionTranscript(db, session.id).messages).toEqual(warm?.committed)
    } finally {
      temp.cleanup(db)
    }
  })

  it.each(['text', 'thinking'] as const)('accepts a rejected tool result after a large %s response was spilled', async (largeContentKind) => {
    const temp = createTempDatabase(`session-context-spilled-rejection-${largeContentKind}-`)
    let db = temp.db
    const session = createSession(db, { name: 'spilled-rejection', model: 'test' })
    const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
    const registry = new ModelProviderRegistry()
    let modelTurn = 0
    registry.register(route, { providerId: 'spilled-rejection-provider', stream: async function* () {
      modelTurn += 1
      if (modelTurn === 1) {
        yield largeContentKind === 'text'
          ? { type: 'text-delta', text: 'x'.repeat(70_000) }
          : { type: 'thinking-delta', text: 'x'.repeat(70_000) }
        yield { type: 'tool-call', toolCallId: 'spilled-call', toolName: 'lookup', input: {} }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text-delta', text: 'rejection understood' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('spilled-rejection-invocation', ['lookup'])
    let warm: SessionContextState | undefined
    try {
      const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id, createSpillStore(spillRoot))
      await runAgentTurn({ registry, routeId: route.routeId, invocationId: 'spilled-rejection-invocation', turnId: 'spilled-rejection-turn', sessionId: session.id,
        history, request: { messages: [{ role: 'user', id: 'spilled-rejection-user', content: 'try lookup' }], maxTokens: 32 },
        sessionTranscriptBaseVersion: 0, sessionTranscriptCommitProtocol: 2, maxModelTurns: 2,
        safetyGate: new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy: createAgentSdkSafetyPolicy() }),
        prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId,
          capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
        toolExecution: createToolExecutionPort(), beforeToolDispatch: async () => ({ kind: 'reject', reasonCode: 'TEST_REJECT', message: 'lookup blocked' }),
        onSessionContextCommitted: (state) => { warm = state } })
      expect(warm?.committed.filter((message) => message.role === 'tool')).toMatchObject([
        { role: 'tool', toolCallId: 'spilled-call', content: 'lookup blocked', isError: true }
      ])
      const version = readSessionTranscript(db, session.id).version
      expect(restoreSessionContext({ committedVersion: version, events: (await history.read('spilled-rejection-invocation')).events }).committed).toEqual(warm?.committed)
      db.close()
      db = openDatabase(temp.dbPath)
      const reopened = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id, createSpillStore(spillRoot))
      expect(restoreSessionContext({ committedVersion: version, events: (await reopened.read('spilled-rejection-invocation')).events }).committed).toEqual(warm?.committed)
      expect(readSessionTranscript(db, session.id).messages).toEqual(warm?.committed)
    } finally {
      await fs.rm(spillRoot, { recursive: true, force: true })
      temp.cleanup(db)
    }
  })

  it('uses a full baseline when the SDK first introduces an existing legacy transcript to protocol 2', async () => {
    const temp = createTempDatabase('session-context-legacy-upgrade-')
    let db = temp.db
    const session = createSession(db, { name: 'context-legacy-upgrade', model: 'test' })
    const prior: CanonicalModelMessage[] = [
      { role: 'user', id: 'legacy-user', content: 'legacy question' },
      { role: 'assistant', id: 'legacy-answer', content: 'legacy answer' }
    ]
    expect(commitSessionTranscript(db, { sessionId: session.id, turnId: 'legacy-turn', baseVersion: 0,
      outcome: 'completed', messages: prior })).toEqual({ committed: true, version: 1 })
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'legacy-upgrade-provider', stream: async function* () {
      yield { type: 'text-delta', text: 'new answer' }
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish', reason: 'stop' }
    } })
    const current: CanonicalModelMessage = { role: 'user', id: 'new-user', content: 'new question' }
    let warm: SessionContextState | undefined
    try {
      const execution = createSqliteSessionStorage(db).execution
      const prepared = await execution.prepareHostedContext({ sessionId: session.id, scopeKey: 'session' })
      expect(prepared).toMatchObject({ version: 1, warm: false })
      await runAgentTurn({ registry, routeId: route.routeId, invocationId: 'legacy-upgrade-invocation', turnId: 'legacy-upgrade-turn',
        sessionId: session.id, sessionTranscriptBaseVersion: 1, sessionTranscriptCommitProtocol: 2,
        history: new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id),
        sessionContext: prepared.context, sessionContextInputMessages: [current], sessionContextFailureInputMessages: [current],
        sessionContextBaselineRequired: prepared.baselineRequired,
        requiredUserMessage: { id: 'new-user', message: current },
        request: { messages: [...prior, current], maxTokens: 32 }, maxModelTurns: 1,
        safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(),
          policy: createAgentSdkSafetyPolicy() }), prepareTool: async () => { throw new Error('tools are unused') },
        toolExecution: createToolExecutionPort(), onSessionContextCommitted: (state) => { warm = state } })
      const expected = [...prior, current, { role: 'assistant', content: 'new answer' }]
      expect(warm?.committed).toEqual(expected)
      expect(readSessionTranscript(db, session.id).messages).toEqual(expected)
      expect(await execution.prepareHostedContext({ sessionId: session.id, scopeKey: 'session' })).toMatchObject({ baselineRequired: false })
      db.close()
      db = openDatabase(temp.dbPath)
      expect(readSessionTranscript(db, session.id).messages).toEqual(expected)
    } finally {
      temp.cleanup(db)
    }
  })

  it.each(['completed', 'failed'] as const)('persists a non-empty version-zero Hosted legacy seed through a %s terminal', async (outcome) => {
    const temp = createTempDatabase(`session-context-zero-legacy-${outcome}-`)
    let db = temp.db
    const session = createSession(db, { name: 'zero-version-legacy-seed', model: 'test' })
    const prior: CanonicalModelMessage[] = [
      { role: 'user', id: 'zero-legacy-user', content: 'old question' },
      { role: 'assistant', id: 'zero-legacy-answer', content: 'old answer' }
    ]
    const current: CanonicalModelMessage = { role: 'user', id: 'zero-current-user', content: 'new question' }
    const prepared = await createSqliteSessionStorage(db).execution.prepareHostedContext({ sessionId: session.id, scopeKey: 'session' })
    expect(prepared).toMatchObject({ version: 0, baselineRequired: false })
    const context = restoreLegacySessionContextSnapshot({ invocationId: 'legacy-session-context', turnId: 'legacy-session-context',
      committedVersion: 0, messages: prior, scope: { kind: 'session', sessionId: session.id } })
    const legacySeed = [...prior]
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: `zero-legacy-${outcome}-provider`, stream: async function* () {
      if (outcome === 'failed') throw new Error('deterministic legacy-seed failure')
      yield { type: 'text-delta', text: 'new answer' }
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish', reason: 'stop' }
    } })
    let warm: SessionContextState | undefined

    try {
      const input = {
        registry, routeId: route.routeId, invocationId: `zero-legacy-${outcome}`, turnId: `zero-legacy-${outcome}`, sessionId: session.id,
        sessionTranscriptBaseVersion: 0, sessionTranscriptCommitProtocol: 2 as const,
        history: new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id),
        request: { messages: [...prior, current], maxTokens: 32 }, maxModelTurns: 1,
        sessionContext: context, sessionContextInputMessages: [current], sessionContextFailureInputMessages: [current],
        sessionContextBaselineRequired: prepared.baselineRequired || legacySeed.length > 0,
        sessionTranscriptFailureMessages: [...prior, current], requiredUserMessage: { id: 'zero-current-user', message: current },
        safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(),
          policy: createAgentSdkSafetyPolicy() }), prepareTool: async () => { throw new Error('tools are unused') },
        toolExecution: createToolExecutionPort(), onSessionContextCommitted: (state: SessionContextState) => { warm = state }
      }
      if (outcome === 'failed') await expect(runAgentTurn(input)).rejects.toThrow('deterministic legacy-seed failure')
      else await runAgentTurn(input)
      const expected = outcome === 'failed' ? [...prior, current] : [...prior, current, { role: 'assistant', content: 'new answer' }]
      expect(warm?.committed).toEqual(expected)
      expect(readSessionTranscript(db, session.id).messages).toEqual(expected)
      db.close()
      db = openDatabase(temp.dbPath)
      expect(readSessionTranscript(db, session.id).messages).toEqual(expected)
    } finally {
      temp.cleanup(db)
    }
  })
})
