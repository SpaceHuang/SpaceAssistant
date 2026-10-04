import { describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { appendMessage, createPersistedTurn, createSession } from './operations'
import { createMemoryAppDb } from './testHelpers'
import { cleanupStreamingResiduesOnStartup } from './streamingCleanup'
import { getMessages } from './index'
import { getDbConnection } from './sqliteStore'

describe('cleanupStreamingResiduesOnStartup', () => {
  it('14: downgrades streaming assistant and in-progress toolCalls', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'test' })
    const msgId = randomUUID()
    appendMessage(db, {
      id: msgId,
      sessionId: session.id,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      toolCalls: [
        {
          id: 'toolu_x',
          toolName: 'read_file',
          input: { path: 'a.txt' },
          status: 'calling',
          riskLevel: 'low',
          startedAt: Date.now()
        }
      ]
    })

    const fixed = cleanupStreamingResiduesOnStartup(db)
    expect(fixed).toBe(1)

    const messages = getMessages(db, session.id)
    const msg = messages.find((m) => m.id === msgId)
    expect(msg?.status).toBe('failed')
    expect(msg?.toolCalls?.[0]?.status).toBe('failed')
    expect(msg?.toolCalls?.[0]?.interrupted).toBe(true)
    expect(msg?.toolCalls?.[0]?.result).toEqual({
      success: false,
      error: '工具调用因应用退出中断'
    })
    expect(msg?.toolCalls?.[0]?.completedAt).toBeTypeOf('number')
  })

  it('returns 0 when no streaming messages exist', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'test' })
    appendMessage(db, {
      id: randomUUID(),
      sessionId: session.id,
      role: 'assistant',
      content: 'done',
      timestamp: Date.now(),
      status: 'completed'
    })
    expect(cleanupStreamingResiduesOnStartup(db)).toBe(0)
  })

  it('does not mutate a streaming assistant owned by a persisted turn', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'runtime-owned' })
    appendMessage(db, { id: 'runtime-owned-assistant', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 1, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'runtime-owned-turn', requestId: 'runtime-owned-request', sessionId: session.id, assistantMessageId: 'runtime-owned-assistant', state: 'executing' })
    expect(cleanupStreamingResiduesOnStartup(db)).toBe(0)
    expect(getMessages(db, session.id).find((message) => message.id === 'runtime-owned-assistant')?.status).toBe('streaming')
  })

  it('startup direct SQL cleanup revokes canonical API and projection eligibility', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'cleanup-content-fence' })
    appendMessage(db, { id: 'cleanup-fenced-assistant', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 1, status: 'streaming',
      toolCalls: [{ id: 'cleanup-tool', toolName: 'read_file', input: {}, status: 'executing', riskLevel: 'low' }] })
    const generation = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(session.id) as { generation: string }
    conn.prepare("UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare('INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at) VALUES(?,?,1)')
      .run(session.id, generation.generation)
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version)
      VALUES(?,?,1,1,1,'watermark','invocation',1,1)`).run(session.id, generation.generation)

    expect(cleanupStreamingResiduesOnStartup(db)).toBe(1)

    expect(conn.prepare('SELECT content,status,content_storage_state FROM messages WHERE id=?').get('cleanup-fenced-assistant'))
      .toEqual({ content: 'partial', status: 'failed', content_storage_state: 'legacy' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(conn.prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'revalidation-required' })
  })
})
