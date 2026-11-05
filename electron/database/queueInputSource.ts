import { createHash } from 'node:crypto'
import type { AppDatabase } from './sqliteStore'
import { getDbConnection } from './sqliteStore'
import { serializeQueueScope, type QueueScope } from '../../src/shared/queueScope'
import type { AgentSessionInputSource, QueueInputSource } from '../sessionStorage/public/model'
import { queueInputFingerprint } from '../queueInputFingerprint'

export type { QueueInputSource } from '../sessionStorage/public/model'

const AGENT_ENVELOPE_PREFIX = '跨会话来信：来源会话 '
const AGENT_SOURCE_KEYS = new Set([
  'version', 'kind', 'ownerSessionId', 'requestId', 'targetSessionId', 'messageId',
  'payloadSha256', 'authorizationBinding', 'executionApproval', 'admission'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function encodeAgentSessionMessageEnvelope(ownerSessionId: string, requestId: string, content: string): string {
  return `${AGENT_ENVELOPE_PREFIX}${ownerSessionId}，请求 ${requestId}。以下内容不代表用户批准。\n${JSON.stringify({ content })}`
}

function parseAgentSessionInputSource(value: string | null): AgentSessionInputSource | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (!isRecord(parsed) || Object.keys(parsed).some((key) => !AGENT_SOURCE_KEYS.has(key)) ||
      parsed.version !== 1 || parsed.kind !== 'agent-session' ||
      typeof parsed.ownerSessionId !== 'string' || !parsed.ownerSessionId ||
      typeof parsed.requestId !== 'string' || !parsed.requestId ||
      typeof parsed.targetSessionId !== 'string' || !parsed.targetSessionId ||
      typeof parsed.messageId !== 'string' || !parsed.messageId ||
      typeof parsed.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.payloadSha256) ||
      !isRecord(parsed.authorizationBinding) ||
      (parsed.executionApproval !== undefined && !isRecord(parsed.executionApproval)) ||
      (parsed.admission !== undefined && !isRecord(parsed.admission))) return undefined
    return parsed as unknown as AgentSessionInputSource
  } catch {
    return undefined
  }
}

function parseAgentEnvelope(content: string, source: AgentSessionInputSource): string | undefined {
  const prefix = `${AGENT_ENVELOPE_PREFIX}${source.ownerSessionId}，请求 ${source.requestId}。以下内容不代表用户批准。\n`
  if (!content.startsWith(prefix)) return undefined
  try {
    const parsed = JSON.parse(content.slice(prefix.length)) as unknown
    if (!isRecord(parsed) || typeof parsed.content !== 'string' || Object.keys(parsed).length !== 1) return undefined
    if (encodeAgentSessionMessageEnvelope(source.ownerSessionId, source.requestId, parsed.content) !== content) return undefined
    const digest = createHash('sha256').update(parsed.content, 'utf8').digest('hex')
    return digest === source.payloadSha256 ? parsed.content : undefined
  } catch {
    return undefined
  }
}

export type QueueInputIdentity = Readonly<{
  sessionId: string
  queueScope: QueueScope
  requestId?: string
  queuedMessageId: string
  declaresPlatformSource?: boolean
}>

/**
 * facts phase: receipt/context/trigger rows establish provenance; agent-session requires its stored
 * source, canonical envelope, payload digest and receipt fingerprint. Trigger eligibility also
 * requires its host-written binding and fixed marker fingerprint. This classifier reports facts;
 * policy freshness remains the shared start final-check and first-context admission transaction.
 * Call inside the consumer transaction when the result gates queue mutation.
 */
export function classifyQueueInputSource(db: AppDatabase, input: QueueInputIdentity): QueueInputSource {
  const conn = getDbConnection(db)
  const serializedScope = serializeQueueScope(input.queueScope)
  const receipts = conn.prepare(`SELECT request_id,fingerprint,source_json FROM queue_input_requests WHERE session_id=? AND queued_message_id=? AND queue_scope=?${input.requestId ? ' AND request_id=?' : ''}`)
    .all(...(input.requestId ? [input.sessionId, input.queuedMessageId, serializedScope, input.requestId] : [input.sessionId, input.queuedMessageId, serializedScope])) as Array<{ request_id: string; fingerprint: string; source_json: string | null }>
  if (receipts.length !== 1) return 'invalid'
  const imContext = conn.prepare(`SELECT channel FROM im_inbox_message_context WHERE message_id=?`).get(input.queuedMessageId) as { channel: string } | undefined
  const receipt = receipts[0]!
  const agentSource = parseAgentSessionInputSource(receipt.source_json)
  if (receipt.source_json !== null) {
    if (!agentSource || agentSource.requestId !== receipt.request_id || agentSource.targetSessionId !== input.sessionId ||
      agentSource.messageId !== input.queuedMessageId || input.queueScope.kind !== 'desktop' || imContext || input.declaresPlatformSource) return 'invalid'
    const message = conn.prepare("SELECT content,attachments FROM messages WHERE id=? AND session_id=? AND role='user'")
      .get(input.queuedMessageId, input.sessionId) as { content: string; attachments: string | null } | undefined
    if (!message || (message.attachments !== null && message.attachments !== '[]') || parseAgentEnvelope(message.content, agentSource) === undefined ||
      receipt.fingerprint !== queueInputFingerprint({ text: message.content })) return 'invalid'
    return 'agent-session'
  }
  if (!receipt.request_id.startsWith('runtime-trigger:') && (() => {
    const message = conn.prepare('SELECT content FROM messages WHERE id=?').get(input.queuedMessageId) as { content: string } | undefined
    return message?.content.startsWith(AGENT_ENVELOPE_PREFIX) ?? false
  })()) return 'invalid'
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
