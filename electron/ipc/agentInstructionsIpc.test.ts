import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendMessage, createSession, getDbConnection } from '../database'
import { createMemoryAppDb } from '../database/testHelpers'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { registerAgentIpc } from './agentProtocolIpc'
import type { AppIpcContext } from '../appIpc'

describe('AGENTS.md request snapshot IPC', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined; vi.restoreAllMocks() })

  it('limits index and body reads to the requested session and hides the full work directory', async () => {
    db = createMemoryAppDb()
    const first = createSession(db, { name: 'first' })
    const second = createSession(db, { name: 'second' })
    const history = (sessionId: string) => new SqliteAgentHistory(getDbConnection(db!), 1, () => 20, sessionId)
    const appendRequest = async (sessionId: string, invocationId: string, content: string) => {
      const user = appendMessage(db!, { id: `${invocationId}-user`, sessionId, role: 'user', content: 'hi', timestamp: 1, status: 'sent' })
      await history(sessionId).appendBatch([{
        invocationId, turnId: invocationId, sequence: 1, schemaVersion: 1, eventId: `${invocationId}-request`, idempotencyKey: `${invocationId}-request`,
        kind: 'model-request-started', payload: { requestId: `${invocationId}-request`, modelTurn: 1, attempt: 1,
          requestMetadata: { agentsMdSnapshot: { status: 'loaded', digest: invocationId.padEnd(64, '0'), content, byteLength: content.length, tokenCount: 1, loadedAt: 10, workDir: '/private/workspace/secret-project' } } }
      },
      { invocationId, turnId: invocationId, sequence: 2, schemaVersion: 1, eventId: `${invocationId}-response`, idempotencyKey: `${invocationId}-response`, kind: 'model-response-committed', payload: { requestId: `${invocationId}-request`, modelTurn: 1, attempt: 1, message: { role: 'assistant', content: '', toolCalls: [
        { id: `${invocationId}-call`, name: 'write_file', input: {} }, { id: `${invocationId}-denied-call`, name: 'delete_file', input: {} }
      ] } } },
      { invocationId, turnId: invocationId, sequence: 3, schemaVersion: 1, eventId: `${invocationId}-approval`, idempotencyKey: `${invocationId}-approval`, kind: 'approval-waiting', payload: { toolCallId: `${invocationId}-call`, modelTurn: 1, sourceRequestId: `${invocationId}-request` } },
      { invocationId, turnId: invocationId, sequence: 4, schemaVersion: 1, eventId: `${invocationId}-resolved`, idempotencyKey: `${invocationId}-resolved`, kind: 'approval-resolved', payload: { toolCallId: `${invocationId}-call`, approved: true } },
      { invocationId, turnId: invocationId, sequence: 5, schemaVersion: 1, eventId: `${invocationId}-tool`, idempotencyKey: `${invocationId}-tool`, kind: 'tool-call-started', payload: { toolCallId: `${invocationId}-call`, toolName: 'write_file' } },
      { invocationId, turnId: invocationId, sequence: 6, schemaVersion: 1, eventId: `${invocationId}-denied-approval`, idempotencyKey: `${invocationId}-denied-approval`, kind: 'approval-waiting', payload: { toolCallId: `${invocationId}-denied-call`, modelTurn: 1, sourceRequestId: `${invocationId}-request` } },
      { invocationId, turnId: invocationId, sequence: 7, schemaVersion: 1, eventId: `${invocationId}-denied-resolved`, idempotencyKey: `${invocationId}-denied-resolved`, kind: 'approval-resolved', payload: { toolCallId: `${invocationId}-denied-call`, approved: false } }
      ], 0)
      return user
    }
    await appendRequest(first.id, 'inv-a', 'private instructions')
    await appendRequest(second.id, 'inv-b', 'other session instructions')

    const storage = createSqliteSessionStorage(db)
    const firstHistory = storage.execution.historyFor({ sessionId: first.id })
    expect(firstHistory.listInvocationIds()).toContain('inv-a')
    expect(firstHistory.listInvocationIds()).not.toContain('inv-b')
    const ipcHandlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
    const ctx = {
      db, sessionStorage: storage, workDirManager: { listProfiles: () => [], getActiveProfileId: () => undefined, getActiveWorkDir: () => '' },
      getWorkDir: () => '', getUserDataPath: () => '',
      sessionStorageShim: undefined
    } as unknown as AppIpcContext
    registerAgentIpc({ handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => { ipcHandlers.set(channel, handler) } } as never, ctx)

    const index = await ipcHandlers.get('chat:get-agents-md-request-snapshots')!({}, { sessionId: first.id }) as { entries: Array<Record<string, unknown>> }
    expect(index.entries).toHaveLength(1)
    expect(index.entries[0]).toMatchObject({ invocationId: 'inv-a', bodyAvailable: true, workDirName: 'secret-project', approvalTools: ['write_file', 'delete_file'] })
    expect(JSON.stringify(index)).not.toContain('/private/workspace')
    expect(JSON.stringify(index)).not.toContain('private instructions')

    const ownedBody = await ipcHandlers.get('chat:get-agents-md-request-snapshot')!({}, { sessionId: first.id, invocationId: 'inv-a', modelTurn: 1 })
    expect(ownedBody).toMatchObject({ content: 'private instructions' })
    const foreignBody = await ipcHandlers.get('chat:get-agents-md-request-snapshot')!({}, { sessionId: first.id, invocationId: 'inv-b', modelTurn: 1 })
    expect(foreignBody).toBeUndefined()
  })
})
