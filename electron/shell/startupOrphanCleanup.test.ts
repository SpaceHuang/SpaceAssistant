import { describe, expect, it, vi } from 'vitest'
import { cleanupPersistedOrphansOnStartup } from './startupOrphanCleanup'
import { appendMessage, createPersistedTurn, createSession, getDbConnection, getMessageSkeleton, openDatabase } from '../database'
import { createTempDatabase } from '../database/testHelpers'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'

describe('cleanupPersistedOrphansOnStartup', () => {
  it('只处理 active turn 中带 owner identity 的 executing run_shell，并记录审计结果', async () => {
    const cleanup = vi.fn().mockResolvedValue('cleaned')
    const audit = vi.fn()
    const result = await cleanupPersistedOrphansOnStartup({
      listTurns: () => [
        { turnId: 't1', requestId: 'r1', sessionId: 's1', userMessageId: 'u1', assistantMessageId: 'a1', state: 'executing', version: 1 } as never,
        { turnId: 't2', requestId: 'r2', sessionId: 's1', userMessageId: 'u2', assistantMessageId: 'a2', state: 'terminal', version: 1 } as never
      ],
      getMessageSkeleton: (id) => id === 'a1' ? { id, sessionId: 's1', role: 'assistant', content: '', timestamp: 1, status: 'streaming', schemaVersion: 1, toolCalls: [
        { id: 'tool-1', toolName: 'run_shell', input: {}, status: 'executing', riskLevel: 'high', processPid: 42, processGroupId: 42, processOwnerToken: 'owner' },
        { id: 'tool-2', toolName: 'run_shell', input: {}, status: 'executing', riskLevel: 'high', processPid: 43 }
      ] } : undefined,
      cleanup,
      audit
    })
    expect(result).toBe(1)
    expect(cleanup).toHaveBeenCalledWith({ pid: 42, processGroupId: 42, ownerToken: 'owner' })
    expect(audit).toHaveBeenCalledWith({ turnId: 't1', toolUseId: 'tool-1', result: 'cleaned' })
  })

  it('canonical-only 重启后仍从消息骨架读取 shell owner 元数据清理孤儿进程', async () => {
    const temp = createTempDatabase('orphan-cleanup-canonical-only-')
    let reopened: ReturnType<typeof openDatabase> | undefined
    try {
      const session = createSession(temp.db, { name: 'orphan cleanup', model: 'test' })
      const user = appendMessage(temp.db, { id: 'orphan-user', sessionId: session.id, role: 'user', content: 'run command', timestamp: 1, status: 'sent' }).message
      const assistant = appendMessage(temp.db, { id: 'orphan-assistant', sessionId: session.id, role: 'assistant', content: 'running', timestamp: 2,
        status: 'streaming', toolCalls: [{ id: 'orphan-tool', toolName: 'run_shell', input: {}, status: 'executing', riskLevel: 'high',
          processPid: 42, processGroupId: 43, processOwnerToken: 'owned-process-token' }] }).message
      expect(getMessageSkeleton(temp.db, assistant.id)?.content).toBe('')
      expect(getDbConnection(temp.db).prepare('SELECT content FROM messages WHERE id=?').get(assistant.id)).toEqual({ content: 'running' })
      createPersistedTurn(temp.db, { turnId: 'orphan-turn', requestId: 'orphan-request', sessionId: session.id,
        assistantMessageId: assistant.id, userMessageId: user.id, state: 'executing' })
      const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'orphan-invocation', turnId: 'orphan-turn', sequence: 1, schemaVersion: 1,
        eventId: 'orphan-context', idempotencyKey: 'orphan-context', kind: 'invocation-context-committed',
        payload: { messages: [user, assistant].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) }
      }], 0)
      const conn = getDbConnection(temp.db)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      temp.db.close()
      reopened = openDatabase(temp.dbPath)

      const cleanup = vi.fn().mockResolvedValue('cleaned')
      const count = await cleanupPersistedOrphansOnStartup({
        listTurns: () => [{ turnId: 'orphan-turn', requestId: 'orphan-request', sessionId: session.id,
          userMessageId: user.id, assistantMessageId: assistant.id, state: 'executing', version: 1 } as never],
        getMessageSkeleton: (id) => getMessageSkeleton(reopened!, id), cleanup
      })

      expect(count).toBe(1)
      expect(cleanup).toHaveBeenCalledWith({ pid: 42, processGroupId: 43, ownerToken: 'owned-process-token' })
      expect(getDbConnection(reopened).prepare('SELECT content FROM messages WHERE id=?').get(assistant.id)).toEqual({ content: '' })
    } finally {
      reopened?.close()
      temp.cleanup()
    }
  })
})
