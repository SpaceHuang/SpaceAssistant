import type { AppDatabase } from '../database/sqliteStore'
import { appendMessage, createSession, deleteSession, deleteQueuedUserMessage, enqueueQueuedUserMessage, getSession, reorderQueuedUserMessages, updateQueuedUserMessageContent, updateSession } from '../database/operations'
import { updateMessageContent } from '../database/operations'
import { getDbConnection } from '../database'
import { getProjectedMessage } from '../runtime/sessionTranscriptProjection'
import { writeCanonicalBackedMessageContent } from '../runtime/sessionContentWriteAuthority'
import { SESSION_META_TITLE_GENERATED, SESSION_META_TITLE_OPEN_BACKFILL_ATTEMPTED, SESSION_META_TITLE_USER_CUSTOM } from '../sessionMetadataKeys'
import type { SessionCommands } from './contracts'

export function createSessionCommands(db: AppDatabase): SessionCommands {
  const commands: SessionCommands = {
    appendNonTurnMessage: (message) => appendMessage(db, message),
    createSession: (input) => createSession(db, { ...input, metadata: input.metadata ? { ...input.metadata } : undefined }),
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
        'wechatMeta'
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
    deleteQueuedMessage: (messageId) => deleteQueuedUserMessage(db, messageId),
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
