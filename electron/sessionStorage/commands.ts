import type { AppDatabase } from '../database/sqliteStore'
import { appendMessage, createSession, deleteSession, deleteQueuedUserMessage, deleteQueuedUserMessageInScope, enqueueQueuedUserMessage, enqueueQueuedUserMessageInScope, getQueueInputReceiptInScope, getSession, reorderQueuedUserMessages, updateQueuedUserMessageContent, updateSession, setSessionUsage, deleteSessionUsage, updateMessageContentIfStreaming } from '../database/operations'
import { updateMessageContent } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { getProjectedMessage } from './infrastructure/sqlite/sessionTranscriptProjection'
import { writeCanonicalBackedMessageContent } from './infrastructure/sqlite/sessionContentWriteAuthority'
import { SESSION_META_TITLE_GENERATED, SESSION_META_TITLE_OPEN_BACKFILL_ATTEMPTED, SESSION_META_TITLE_USER_CUSTOM } from '../sessionMetadataKeys'
import type { SessionCommands } from './public/ports'
import type { RuntimeTriggerRecord, RuntimeTriggerPatch } from './public/model'
import { classifyQueueInputSource } from '../database/queueInputSource'
import { serializeQueueScope } from '../../src/shared/queueScope'
import type { SessionUsage } from '../../src/shared/sessionUsage'
import { hasPlanMetadataKeys, stripPlanFieldsFromSessionMetadata } from '../../src/shared/planTypes'

type TriggerRow = { id:string; owner_session_id:string; receiver_session_id:string; client_key:string; definition_json:string; state:RuntimeTriggerRecord['state']; created_at:number; expires_at:number; matched_at:number|null; event_json:string|null; message_id:string|null; attempts:number; next_attempt_at:number|null; result_json:string|null; revision:number; updated_at:number }
function decodeTriggerJsonObject(raw: string | null, field: string): Record<string, unknown> | undefined {
  if (raw === null) return undefined
  try { const value: unknown = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown> }
  catch { throw new Error(`RUNTIME_TRIGGER_${field.toUpperCase()}_JSON_INVALID`) }
}
function decodeRuntimeTriggerRow(row: TriggerRow): RuntimeTriggerRecord {
  let definition: unknown
  try { definition = JSON.parse(row.definition_json) } catch { throw new Error('RUNTIME_TRIGGER_DEFINITION_JSON_INVALID') }
  if (!definition || typeof definition !== 'object' || Array.isArray(definition) || (definition as { version?: unknown }).version !== 1) throw new Error('RUNTIME_TRIGGER_DEFINITION_VERSION_UNSUPPORTED')
  const event = decodeTriggerJsonObject(row.event_json, 'event')
  const result = decodeTriggerJsonObject(row.result_json, 'result')
  return { id:row.id,ownerSessionId:row.owner_session_id,receiverSessionId:row.receiver_session_id,clientKey:row.client_key,definition:definition as RuntimeTriggerRecord['definition'],state:row.state,createdAt:row.created_at,expiresAt:row.expires_at,
    ...(row.matched_at !== null ? { matchedAt:row.matched_at } : {}),...(event ? { event } : {}),...(row.message_id !== null ? { messageId:row.message_id } : {}),attempts:row.attempts,
    ...(row.next_attempt_at !== null ? { nextAttemptAt:row.next_attempt_at } : {}),...(result ? { result } : {}),revision:row.revision,updatedAt:row.updated_at }
}

export function createSessionCommands(db: AppDatabase): SessionCommands {
  const readRuntimeTrigger = (id: string): RuntimeTriggerRecord | null => {
    const row = getDbConnection(db).prepare(`SELECT id,owner_session_id,receiver_session_id,client_key,definition_json,state,created_at,expires_at,matched_at,event_json,message_id,attempts,next_attempt_at,result_json,revision,updated_at FROM runtime_triggers WHERE id=?`).get(id) as TriggerRow | undefined
    return row ? decodeRuntimeTriggerRow(row) : null
  }
  const runtimeTriggers: SessionCommands['runtimeTriggers'] = {
    read: readRuntimeTrigger,
    findByClientKey: (ownerSessionId, clientKey) => {
      const row = getDbConnection(db).prepare(`SELECT id,owner_session_id,receiver_session_id,client_key,definition_json,state,created_at,expires_at,matched_at,event_json,message_id,attempts,next_attempt_at,result_json,revision,updated_at FROM runtime_triggers WHERE owner_session_id=? AND client_key=?`).get(ownerSessionId, clientKey) as TriggerRow | undefined
      return row ? decodeRuntimeTriggerRow(row) : null
    },
    listByOwner: ({ ownerSessionId, cursor, limit }) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('invalid runtime trigger page limit')
      const rows = cursor
        ? getDbConnection(db).prepare(`SELECT id,owner_session_id,receiver_session_id,client_key,definition_json,state,created_at,expires_at,matched_at,event_json,message_id,attempts,next_attempt_at,result_json,revision,updated_at FROM runtime_triggers WHERE owner_session_id=? AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?`).all(ownerSessionId,cursor.createdAt,cursor.createdAt,cursor.id,limit + 1)
        : getDbConnection(db).prepare(`SELECT id,owner_session_id,receiver_session_id,client_key,definition_json,state,created_at,expires_at,matched_at,event_json,message_id,attempts,next_attempt_at,result_json,revision,updated_at FROM runtime_triggers WHERE owner_session_id=? ORDER BY created_at,id LIMIT ?`).all(ownerSessionId,limit + 1)
      return (rows as TriggerRow[]).map(decodeRuntimeTriggerRow)
    },
    listByState: (state, limit = 4_096) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4_096) throw new TypeError('invalid runtime trigger recovery limit')
      const rows = getDbConnection(db).prepare(`SELECT id,owner_session_id,receiver_session_id,client_key,definition_json,state,created_at,expires_at,matched_at,event_json,message_id,attempts,next_attempt_at,result_json,revision,updated_at FROM runtime_triggers WHERE state=? ORDER BY created_at,id LIMIT ?`).all(state, limit) as TriggerRow[]
      return rows.map(decodeRuntimeTriggerRow)
    },
    countActive: (input = {}) => Number(getDbConnection(db).prepare(`SELECT COUNT(*) AS count FROM runtime_triggers WHERE state IN ('waiting','matched') AND expires_at>?${input.ownerSessionId ? ' AND owner_session_id=?' : ''}`).get(...(input.ownerSessionId ? [input.now ?? Date.now(), input.ownerSessionId] : [input.now ?? Date.now()]))?.count ?? 0),
    findActiveSyncTarget: (receiverSessionId) => {
      const row = getDbConnection(db).prepare(`SELECT id,owner_session_id,receiver_session_id,client_key,definition_json,state,created_at,expires_at,matched_at,event_json,message_id,attempts,next_attempt_at,result_json,revision,updated_at FROM runtime_triggers WHERE receiver_session_id=? AND state IN ('waiting','matched') AND json_extract(definition_json,'$.condition.type')='session_steps' AND json_extract(definition_json,'$.condition.mode')='sync'`).get(receiverSessionId) as TriggerRow | undefined
      return row ? decodeRuntimeTriggerRow(row) : null
    },
    insert: (input) => {
      const conn = getDbConnection(db)
      return runInTransaction(conn, () => {
        conn.prepare(`INSERT INTO runtime_triggers(id,owner_session_id,receiver_session_id,client_key,definition_json,state,created_at,expires_at,matched_at,event_json,message_id,attempts,next_attempt_at,result_json,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(input.id,input.ownerSessionId,input.receiverSessionId,input.clientKey,JSON.stringify(input.definition),input.state,input.createdAt,input.expiresAt,input.matchedAt ?? null,input.event ? JSON.stringify(input.event) : null,input.messageId ?? null,input.attempts,input.nextAttemptAt ?? null,input.result ? JSON.stringify(input.result) : null,input.revision,input.updatedAt)
        const inserted = readRuntimeTrigger(input.id)
        if (!inserted) throw new Error('RUNTIME_TRIGGER_INSERT_NOT_READABLE')
        return inserted
      })
    },
    update: (id, expectedRevision, patch) => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || Object.keys(patch).length === 0) throw new TypeError('invalid runtime trigger update')
      if (patch.state === 'matched' && (!Number.isSafeInteger(patch.matchedAt) || !patch.event || !Number.isSafeInteger(patch.event.occurredAt))) return null
      const columns: Record<keyof RuntimeTriggerPatch, string> = { state:'state',matchedAt:'matched_at',event:'event_json',messageId:'message_id',attempts:'attempts',nextAttemptAt:'next_attempt_at',result:'result_json',updatedAt:'updated_at' }
      const entries = Object.entries(patch) as Array<[keyof RuntimeTriggerPatch, RuntimeTriggerPatch[keyof RuntimeTriggerPatch]]>
      const assignments = entries.map(([key]) => `${columns[key]}=?`).join(',')
      const values = entries.map(([key,value]) => key === 'event' || key === 'result' ? value === undefined ? null : JSON.stringify(value) : (value ?? null) as string | number | null)
      const conn = getDbConnection(db)
      return runInTransaction(conn, () => {
        const transition = patch.state === undefined
          ? "state IN ('waiting','matched')"
          : patch.state === 'matched' ? "state='waiting' AND expires_at>=? AND (json_extract(definition_json,'$.condition.type')!='session_steps' OR json_extract(definition_json,'$.condition.mode')!='sync' OR expires_at>=?)"
            : ['cancelled','expired','failed'].includes(patch.state) ? "state IN ('waiting','matched')"
              : patch.state === 'completed' ? "state='matched'" : '0'
        const transitionValues = patch.state === 'matched' ? [Number(patch.event?.occurredAt), Number(patch.matchedAt)] : []
        const changed = conn.prepare(`UPDATE runtime_triggers SET ${assignments},revision=revision+1 WHERE id=? AND revision=? AND ${transition}`).run(...values,id,expectedRevision,...transitionValues)
        return Number(changed.changes) === 1 ? readRuntimeTrigger(id) : null
      })
    }
  }
  const commands: SessionCommands = {
    scopedQueue: {
      enqueue: (input) => enqueueQueuedUserMessageInScope(db, input),
      readReceipt: ({ sessionId, requestId, queueScope }) => {
        const receipt = getQueueInputReceiptInScope(db, sessionId, requestId, queueScope)
        return receipt ? { sessionId: receipt.sessionId, requestId: receipt.requestId, fingerprint: receipt.fingerprint,
          ...(receipt.queuedMessageId ? { queuedMessageId: receipt.queuedMessageId } : {}), ...(receipt.turnId ? { turnId: receipt.turnId } : {}), state: receipt.state } : undefined
      },
      cancelUnstartedInput: ({ sessionId, requestId, queueScope, expectedSource }) => {
        const conn = getDbConnection(db)
        return runInTransaction(conn, () => {
          const receipt = getQueueInputReceiptInScope(db, sessionId, requestId, queueScope)
          if (!receipt?.queuedMessageId || receipt.state !== 'queued' || !['runtime-trigger', 'ordinary-desktop', 'platform-im'].includes(expectedSource)) return false
          if (classifyQueueInputSource(db, { sessionId, queueScope, requestId, queuedMessageId: receipt.queuedMessageId }) !== expectedSource) return false
          const deleted = deleteQueuedUserMessageInScope(db, receipt.queuedMessageId, queueScope)
          return deleted.ok
        })
      },
      cancelUndispatchedRuntimeInput: ({ sessionId, requestId, queueScope, expectedTurnId }) => {
        if (!requestId.startsWith('runtime-trigger:')) return false
        const conn = getDbConnection(db)
        const cancelled = runInTransaction(conn, () => {
          const receipt = getQueueInputReceiptInScope(db, sessionId, requestId, queueScope)
          if (!receipt?.queuedMessageId || classifyQueueInputSource(db, { sessionId, requestId, queueScope, queuedMessageId: receipt.queuedMessageId }) !== 'runtime-trigger') return false
          const scope = serializeQueueScope(queueScope)
          if (receipt.state === 'queued') {
            const deleted = deleteQueuedUserMessageInScope(db, receipt.queuedMessageId, queueScope)
            return deleted.ok
          }
          if (receipt.state !== 'claimed' || !receipt.turnId || (expectedTurnId && receipt.turnId !== expectedTurnId)) return false
          const turn = conn.prepare(`SELECT state,version,assistant_message_id,user_message_id,request_id,session_id FROM turns WHERE turn_id=?`)
            .get(receipt.turnId) as { state: string; version: number; assistant_message_id: string; user_message_id: string; request_id: string; session_id: string } | undefined
          if (!turn || turn.session_id !== sessionId || turn.request_id !== requestId || turn.user_message_id !== receipt.queuedMessageId ||
            !['prepared', 'configuring'].includes(turn.state)) return false
          const changed = conn.prepare(`UPDATE turns SET state='terminal',outcome='cancelled',version=version+1,updated_at=?
            WHERE turn_id=? AND session_id=? AND request_id=? AND state IN ('prepared','configuring')`).run(Date.now(), receipt.turnId, sessionId, requestId)
          if (Number(changed.changes) !== 1) return false
          conn.prepare("UPDATE messages SET status='cancelled' WHERE id=? AND session_id=? AND status IN ('sent','streaming')")
            .run(receipt.queuedMessageId, sessionId)
          conn.prepare("UPDATE messages SET status='cancelled' WHERE id=? AND session_id=? AND role='assistant' AND status='streaming'")
            .run(turn.assistant_message_id, sessionId)
          const receiptChanged = conn.prepare(`UPDATE queue_input_requests SET state='cancelled',updated_at=?
            WHERE session_id=? AND request_id=? AND queued_message_id=? AND turn_id=? AND queue_scope=? AND state='claimed'`)
            .run(Date.now(), sessionId, requestId, receipt.queuedMessageId, receipt.turnId, scope)
          return Number(receiptChanged.changes) === 1
        })
        if (cancelled) db.save()
        return cancelled
      }
    },
    runtimeTriggers,
    appendNonTurnMessage: (message) => appendMessage(db, message),
    updateStreamingMessage: (messageId, patch) => updateMessageContentIfStreaming(db, messageId, patch),
    createSession: (input) => createSession(db, {
      ...input,
      metadata: { ...(input.metadata ?? {}) }
    }),
    renameSession: (sessionId, name) => {
      const current = getSession(db, sessionId)
      if (!current) return undefined
      const trimmedName = name.trim()
      const changed = trimmedName !== '' && trimmedName !== current.name.trim()
      return updateSession(db, sessionId, {
        ...(changed ? { name: trimmedName, metadata: { ...current.metadata, [SESSION_META_TITLE_USER_CUSTOM]: true } } : {})
      })
    },
    updateSettings: ({ sessionId, ...settings }) => {
      if (!getSession(db, sessionId)) return undefined
      return updateSession(db, sessionId, settings)
    },
    setSessionUsage: (sessionId, usage) => setSessionUsage(db, sessionId, usage),
    deleteSessionUsage: (sessionId) => deleteSessionUsage(db, sessionId),
    stripLegacyPlanMetadata: (sessionId) => {
      const current = getSession(db, sessionId)
      if (!current || !hasPlanMetadataKeys(current.metadata)) return current
      return updateSession(db, sessionId, { metadata: stripPlanFieldsFromSessionMetadata(current.metadata) })
    },
    updateUserMetadata: (sessionId, metadataPatch) => {
      const current = getSession(db, sessionId)
      if (!current) return undefined
      const metadata = { ...current.metadata, ...metadataPatch }
      const ownedKeys = [
        SESSION_META_TITLE_GENERATED,
        SESSION_META_TITLE_USER_CUSTOM,
        SESSION_META_TITLE_OPEN_BACKFILL_ATTEMPTED,
        'sessionDirectoryGrants',
        'remoteSessionLastActivityAt',
        'feishuMessageId',
        'wechatMessageId',
        'wechatMeta',
      ]
      for (const key of ownedKeys) {
        if (!Object.prototype.hasOwnProperty.call(metadataPatch, key)) continue
        if (Object.prototype.hasOwnProperty.call(current.metadata, key)) metadata[key] = current.metadata[key]
        else delete metadata[key]
      }
      return updateSession(db, sessionId, { metadata })
    },
    updateDirectoryGrants: (sessionId, grants) => {
      const current = getSession(db, sessionId)
      if (!current) return undefined
      return updateSession(db, sessionId, { metadata: { ...current.metadata, sessionDirectoryGrants: [...grants] } })
    },
    updateTitleSuggestionState: (sessionId, state) => {
      const current = getSession(db, sessionId)
      if (!current) return undefined
      const metadata = { ...current.metadata }
      if (state.generated !== undefined) {
        if (state.generated) metadata[SESSION_META_TITLE_GENERATED] = true
        else delete metadata[SESSION_META_TITLE_GENERATED]
      }
      if (state.backfillAttempted !== undefined) {
        if (state.backfillAttempted) metadata[SESSION_META_TITLE_OPEN_BACKFILL_ATTEMPTED] = true
        else delete metadata[SESSION_META_TITLE_OPEN_BACKFILL_ATTEMPTED]
      }
      return updateSession(db, sessionId, { metadata })
    },
    applyGeneratedTitle: (sessionId, title) => {
      const current = getSession(db, sessionId)
      if (!current || current.metadata?.[SESSION_META_TITLE_GENERATED] === true || current.metadata?.[SESSION_META_TITLE_USER_CUSTOM] === true) return undefined
      return updateSession(db, sessionId, { name: title, metadata: { ...current.metadata, [SESSION_META_TITLE_GENERATED]: true } })
    },
    recordRemoteSessionActivity: (sessionId, at) => {
      if (!Number.isFinite(at)) throw new Error('REMOTE_ACTIVITY_TIMESTAMP_INVALID')
      const current = getSession(db, sessionId)
      if (!current) return undefined
      const previousValue = current.metadata.remoteSessionLastActivityAt
      const previous = typeof previousValue === 'number' && Number.isFinite(previousValue) ? previousValue : 0
      const next = Math.max(previous, at)
      if (next === previous) return current
      return updateSession(db, sessionId, { metadata: { ...current.metadata, remoteSessionLastActivityAt: next } })
    },
    recordRemoteSessionIdentity: (sessionId, identity) => {
      const current = getSession(db, sessionId)
      if (!current) return undefined
      if (identity.channel === 'feishu') {
        return updateSession(db, sessionId, { metadata: { ...current.metadata, feishuMessageId: identity.messageId } })
      }
      const existingMeta = current.metadata.wechatMeta
      const wechatMeta = existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)
        ? existingMeta as Record<string, unknown>
        : {}
      return updateSession(db, sessionId, {
        ...(current.workDirProfileId || !identity.workDirProfileId ? {} : { workDirProfileId: identity.workDirProfileId }),
        metadata: {
          ...current.metadata,
          wechatMessageId: identity.messageId,
          wechatMeta: { ...wechatMeta, userId: identity.userId, lastMessageId: identity.messageId, lastContextToken: identity.contextToken }
        }
      })
    },
    deleteQueuedMessage: (messageId, previewCandidate) => deleteQueuedUserMessage(db, messageId, previewCandidate),
    editQueuedMessage: (input) => updateQueuedUserMessageContent(db, input),
    reorderQueuedMessages: (input) => reorderQueuedUserMessages(db, input),
    deleteSession: (sessionId) => { deleteSession(db, sessionId, { flush: false }) },
    updateToolCallScrollback: ({ sessionId, messageId, toolCalls }) => {
      const current = getProjectedMessage(db, messageId)
      if (!current || current.sessionId !== sessionId) return null
      const currentToolCalls = current.toolCalls ?? []
      if (!containsTerminalScrollback(toolCalls) || !sameToolCallsExceptScrollback(currentToolCalls, toolCalls)) {
        throw new Error('TOOL_CALL_SCROLLBACK_PATCH_INVALID')
      }
      return updateMessageContent(db, messageId, { toolCalls })
    },
    enqueue: (input) => enqueueQueuedUserMessage(db, input),
    editMessage: async ({ sessionId, messageId, content }) => {
      const current = getProjectedMessage(db, messageId)
      if (!current || current.sessionId !== sessionId) return false
      const storage = getDbConnection(db).prepare('SELECT content_storage_state FROM messages WHERE id=? AND session_id=?')
        .get(messageId, sessionId) as { content_storage_state: string } | undefined
      if (storage?.content_storage_state === 'canonical-backed-dual-write') {
        const committed = await writeCanonicalBackedMessageContent(db, messageId, content)
        if (!committed) throw new Error('canonical-backed message edit could not be committed')
        return true
      }
      return updateMessageContent(db, messageId, { content }) !== null
    }
  }
  return Object.freeze(commands)
}

function containsTerminalScrollback(toolCalls: NonNullable<import('../../src/shared/domainTypes').Message['toolCalls']>): boolean {
  return toolCalls.some((tool) => {
    const data = tool.result?.data
    return Boolean(data && typeof data === 'object' && 'terminalScrollback' in data)
  })
}

function sameToolCallsExceptScrollback(
  current: NonNullable<import('../../src/shared/domainTypes').Message['toolCalls']>,
  next: NonNullable<import('../../src/shared/domainTypes').Message['toolCalls']>
): boolean {
  const withoutScrollback = (toolCalls: typeof current) => toolCalls.map((tool) => {
    if (!tool.result || !tool.result.data || typeof tool.result.data !== 'object') return tool
    const data = { ...tool.result.data } as Record<string, unknown>
    delete data.terminalScrollback
    return { ...tool, result: { ...tool.result, data } }
  })
  const left = stableJson(withoutScrollback(current))
  const right = stableJson(withoutScrollback(next))
  return left === right
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
