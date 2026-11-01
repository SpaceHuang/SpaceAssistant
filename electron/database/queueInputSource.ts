import type { AppDatabase } from './sqliteStore'
import { getDbConnection } from './sqliteStore'
import { serializeQueueScope, type QueueScope } from '../../src/shared/queueScope'
import type { QueueInputSource } from '../sessionStorage/public/model'

export type { QueueInputSource } from '../sessionStorage/public/model'

export type QueueInputIdentity = Readonly<{
  sessionId: string
  queueScope: QueueScope
  requestId?: string
  queuedMessageId: string
  declaresPlatformSource?: boolean
}>

/**
 * facts-only source classifier: a prefix is a routing hint, while receipt/context/trigger rows
 * establish provenance. Call inside the consumer transaction when the result gates mutation.
 */
export function classifyQueueInputSource(db: AppDatabase, input: QueueInputIdentity): QueueInputSource {
  const conn = getDbConnection(db)
  const serializedScope = serializeQueueScope(input.queueScope)
  const receipts = conn.prepare(`SELECT request_id FROM queue_input_requests WHERE session_id=? AND queued_message_id=? AND queue_scope=?${input.requestId ? ' AND request_id=?' : ''}`)
    .all(...(input.requestId ? [input.sessionId, input.queuedMessageId, serializedScope, input.requestId] : [input.sessionId, input.queuedMessageId, serializedScope])) as Array<{ request_id: string }>
  if (!receipts.length) return 'invalid'
  const imContext = conn.prepare(`SELECT channel FROM im_inbox_message_context WHERE message_id=?`).get(input.queuedMessageId) as { channel: string } | undefined
  const triggerReceipts = receipts.filter((receipt) => receipt.request_id.startsWith('runtime-trigger:'))
  const triggers = triggerReceipts.map((receipt) => conn.prepare(`SELECT state FROM runtime_triggers WHERE receiver_session_id=? AND id=?`)
    .get(input.sessionId, receipt.request_id.slice('runtime-trigger:'.length)) as { state: string } | undefined)
  const trigger = triggers.length === 1 ? triggers[0] : undefined
  const triggerPrefix = triggerReceipts.length > 0
  if (imContext && triggerPrefix) return 'invalid'
  if (input.declaresPlatformSource && triggerPrefix) return 'invalid'
  if (imContext) return input.queueScope.kind === 'im' && input.queueScope.channel === imContext.channel && !triggerPrefix ? 'platform-im' : 'invalid'
  if (triggerPrefix) return trigger && ['waiting', 'matched', 'queued', 'processing', 'delivery_pending'].includes(trigger.state) ? 'runtime-trigger' : 'invalid'
  if (input.declaresPlatformSource) return 'invalid'
  return input.queueScope.kind === 'desktop' ? 'ordinary-desktop' : 'invalid'
}
