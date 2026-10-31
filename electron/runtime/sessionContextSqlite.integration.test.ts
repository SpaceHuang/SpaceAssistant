import { describe, expect, it } from 'vitest'
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
import { createSession } from '../database/operations'
import { commitSessionTranscript, readSessionTranscript } from '../database/sessionTranscript'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import type { SessionContextState } from '../../packages/agent-sdk/src/sessionContext'
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
      policy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'auth-v1' }) } })
    const toolExecution = createPermitBoundToolExecutionPort({ permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
      resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
      execute: async (call) => ({ output: `result-${call.toolCallId}` }) })
    let context: SessionContextState | undefined

    try {
      await runAgentTurn({ registry, routeId: route.routeId, invocationId: 'multi-tool-invocation', turnId: 'multi-tool-turn', sessionId: session.id,
        history: new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id), request: { messages: [{ role: 'user', id: 'user-tools', content: 'run tools' }], maxTokens: 32 },
        sessionTranscriptBaseVersion: 0, sessionTranscriptCommitProtocol: 2, maxModelTurns: 2, safetyGate,
        prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName,
          phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
        toolExecution, onSessionContextCommitted: (next) => { context = next } })
      const warm = context!.committed
      const warmToolResults = warm.filter((message) => message.role === 'tool')
      expect(warmToolResults).toMatchObject([
        { role: 'tool', toolCallId: 'tool-a', content: 'result-tool-a' },
        { role: 'tool', toolCallId: 'tool-b', content: 'result-tool-b' }
      ])
      expect(warmToolResults).toHaveLength(2)
      expect(readSessionTranscript(db, session.id).messages).toEqual(warm)
      db.close()
      db = openDatabase(temp.dbPath)
      expect(readSessionTranscript(db, session.id).messages).toEqual(warm)
    } finally {
      temp.cleanup(db)
    }
  })

  it('uses a full baseline when the SDK first introduces an existing legacy transcript to protocol 2', async () => {
    const temp = createTempDatabase('session-context-legacy-upgrade-')
    const db = temp.db
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
      await runAgentTurn({ registry, routeId: route.routeId, invocationId: 'legacy-upgrade-invocation', turnId: 'legacy-upgrade-turn',
        sessionId: session.id, sessionTranscriptBaseVersion: 1, sessionTranscriptCommitProtocol: 2,
        history: new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id),
        request: { messages: [...prior, current], maxTokens: 32 }, maxModelTurns: 1,
        safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(),
          policy: createAgentSdkSafetyPolicy() }), prepareTool: async () => { throw new Error('tools are unused') },
        toolExecution: createToolExecutionPort(), onSessionContextCommitted: (state) => { warm = state } })
      const expected = [...prior, current, { role: 'assistant', content: 'new answer' }]
      expect(warm?.committed).toEqual(expected)
      expect(readSessionTranscript(db, session.id).messages).toEqual(expected)
    } finally {
      temp.cleanup(db)
    }
  })
})
