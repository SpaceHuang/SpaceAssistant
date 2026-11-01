import type { AppDatabase } from './sqliteStore'
import { getDbConnection } from './sqliteStore'
import { serializeQueueScope, type QueueScope } from '../../src/shared/queueScope'
import type { QueueInputSource } from '../sessionStorage/public/model'
import { queueInputFingerprint } from '../queueInputFingerprint'

export type { QueueInputSource } from '../sessionStorage/public/model'

export type QueueInputIdentity = Readonly<{
  sessionId: string
  queueScope: QueueScope
  requestId?: string
  queuedMessageId: string
  declaresPlatformSource?: boolean
}>

/**
 * facts phase: receipt/context/trigger rows establish provenance; trigger queue eligibility also
 * requires its host-written binding and fixed marker fingerprint. Current policy freshness remains
 * the shared start final-check in TurnRuntime and the first-context SQLite admission transaction.
 * Call inside the consumer transaction when the result gates queue mutation.
 */
export function classifyQueueInputSource(db: AppDatabase, input: QueueInputIdentity): QueueInputSource {
  const conn = getDbConnection(db)
  const serializedScope = serializeQueueScope(input.queueScope)
  const receipts = conn.prepare(`SELECT request_id,fingerprint FROM queue_input_requests WHERE session_id=? AND queued_message_id=? AND queue_scope=?${input.requestId ? ' AND request_id=?' : ''}`)
    .all(...(input.requestId ? [input.sessionId, input.queuedMessageId, serializedScope, input.requestId] : [input.sessionId, input.queuedMessageId, serializedScope])) as Array<{ request_id: string; fingerprint: string }>
  if (!receipts.length) return 'invalid'
  const imContext = conn.prepare(`SELECT channel FROM im_inbox_message_context WHERE message_id=?`).get(input.queuedMessageId) as { channel: string } | undefined
  const triggerReceipts = receipts.filter((receipt) => receipt.request_id.startsWith('runtime-trigger:'))
  const triggers = triggerReceipts.map((receipt) => conn.prepare(`SELECT owner_session_id,state,definition_json,result_json FROM runtime_triggers WHERE receiver_session_id=? AND id=?`)
    .get(input.sessionId, receipt.request_id.slice('runtime-trigger:'.length)) as { owner_session_id: string; state: string; definition_json: string; result_json: string | null } | undefined)
  const trigger = triggers.length === 1 ? triggers[0] : undefined
  const triggerPrefix = triggerReceipts.length > 0
  if (imContext && triggerPrefix) return 'invalid'
  if (input.declaresPlatformSource && triggerPrefix) return 'invalid'
  if (imContext) return input.queueScope.kind === 'im' && input.queueScope.channel === imContext.channel && !triggerPrefix ? 'platform-im' : 'invalid'
  if (triggerPrefix) {
    if (!trigger || !['matched'].includes(trigger.state) || !trigger.result_json) return 'invalid'
    try {
      const definition = JSON.parse(trigger.definition_json) as { condition?: { type?: string; mode?: string } }
      const result = JSON.parse(trigger.result_json) as { authorization?: Record<string, unknown>; pauseAcceptedBySdk?: unknown }
      const requestId = triggerReceipts[0]!.request_id
      const message = conn.prepare('SELECT content FROM messages WHERE id=? AND session_id=? AND role=?').get(input.queuedMessageId, input.sessionId, 'user') as { content: string } | undefined
      const receipt = receipts.find((item) => item.request_id === requestId)
      const marker = `运行时事件待处理：${requestId.slice('runtime-trigger:'.length)}`
      const binding = result.authorization
      if (!binding || binding.bindingVersion !== 1 || binding.requestId !== requestId || binding.receiverSessionId !== input.sessionId ||
        binding.ownerSessionId !== trigger.owner_session_id ||
        JSON.stringify(binding.queueScope) !== JSON.stringify(input.queueScope) || typeof binding.payloadDigest !== 'string' || !binding.payloadDigest ||
        typeof binding.authorizationGeneration !== 'string' || !binding.authorizationGeneration || typeof binding.policyRevision !== 'string' || !binding.policyRevision ||
        typeof binding.runtimeGeneration !== 'string' || !binding.runtimeGeneration ||
        !message || message.content !== marker || receipt?.fingerprint !== queueInputFingerprint({ text: marker }) ||
        (definition.condition?.type === 'session_steps' && definition.condition.mode === 'sync' && result.pauseAcceptedBySdk !== true)) return 'invalid'
      return 'runtime-trigger'
    } catch { return 'invalid' }
  }
  if (input.declaresPlatformSource) return 'invalid'
  return input.queueScope.kind === 'desktop' ? 'ordinary-desktop' : 'invalid'
}
