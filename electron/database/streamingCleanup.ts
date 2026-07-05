import { randomUUID } from 'crypto'
import type { ToolCallRecord, ToolCallStatus } from '../../src/shared/domainTypes'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { deserializeToolCallsFromDb, serializeToolCallsForDb } from '../messageCodec'
import type { AppDatabase } from './index'
import { getDbConnection } from './sqliteStore'

const INTERRUPTED_ERROR = '工具调用因应用退出中断'
const IN_PROGRESS: ToolCallStatus[] = ['calling', 'confirming', 'executing']

function downgradeToolCall(tc: ToolCallRecord, now: number): ToolCallRecord {
  if (!IN_PROGRESS.includes(tc.status)) {
    if (tc.result) return tc
    return {
      ...tc,
      status: 'failed',
      interrupted: true,
      result: { success: false, error: INTERRUPTED_ERROR },
      completedAt: tc.completedAt ?? now
    }
  }
  return {
    ...tc,
    status: 'failed',
    interrupted: true,
    result: tc.result ?? { success: false, error: INTERRUPTED_ERROR },
    completedAt: tc.completedAt ?? now
  }
}

export function cleanupStreamingResiduesOnStartup(db: AppDatabase): number {
  const conn = getDbConnection(db)
  const rows = conn
    .prepare(`SELECT id, tool_calls FROM messages WHERE role = 'assistant' AND status = 'streaming'`)
    .all() as Array<{ id: string; tool_calls: string | null }>

  if (rows.length === 0) return 0

  const now = Date.now()
  const update = conn.prepare(
    `UPDATE messages SET status = 'failed', tool_calls = @toolCalls WHERE id = @id`
  )

  for (const row of rows) {
    const toolCalls = deserializeToolCallsFromDb(row.tool_calls)
    const patched = toolCalls?.map((tc) => downgradeToolCall(tc, now)) ?? undefined
    update.run({
      id: row.id,
      toolCalls: serializeToolCallsForDb(patched)
    })
  }

  db.save()
  logAgentEvent('info', 'startup.streaming_cleanup', { fixedCount: rows.length })
  return rows.length
}

export function createCorruptedToolCallPlaceholder(): ToolCallRecord {
  return {
    id: `corrupted-${randomUUID()}`,
    toolName: 'unknown',
    input: {},
    status: 'failed',
    riskLevel: 'low',
    corrupted: true,
    result: { success: false, error: '工具调用记录数据损坏' }
  }
}
