import type { AppDatabase } from '../database/sqliteStore'
import {
  getSession,
  getSessionUsage,
  listSessions,
  getContextHistorySummaryBaseline,
  getMessageSequence,
  getTurnByRequestId,
  listTurnErrorsByAssistantMessageIds,
  getMessages,
  getChatMessagePage,
  getApiContextBaseline,
} from '../database/operations'
import {
  getProjectedApiContextBaseline,
  getProjectedChatMessagePage,
  getProjectedMessage,
  getProjectedMessagesPageWithSequence,
  getProjectedMessages,
  getProjectedSearchCorpusPage,
  getProjectedTurnContext,
  resolveProjectedRetryContext,
  searchProjectedMessages
} from '../runtime/sessionTranscriptProjection'
import type { SessionQueries } from './public/ports'
import type { MessageRef } from './public/model'
import { inspectContinuationSources } from './continuationSources'
import { createRoutingQueries } from './routingQueries'
import { getDbConnection } from '../database/sqliteStore'
import { projectMessageEntriesV1 } from './domain/projectionSpec'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { runInTransaction } from '../database/transaction'
import type { PreparedChatBodyView } from './public/model'
import type { PreparedChatBodySelection } from './infrastructure/sqlite/projectionChatBodyCacheWorkerClient'
import type { Message } from '../../src/shared/domainTypes'

function canonicalBodyMessageIds(db: AppDatabase, sessionId: string, messages: readonly Message[]): string[] {
  if (messages.length === 0) return []
  const ids = messages.map(({ id }) => id)
  const rows = getDbConnection(db).prepare(`SELECT messages.id,messages.content_storage_state,cutover.write_mode
    FROM messages LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=messages.session_id
    WHERE messages.session_id=? AND messages.id IN (${ids.map(() => '?').join(',')})`).all(sessionId, ...ids) as
    Array<{ id: string; content_storage_state: string; write_mode: string | null }>
  const stateById = new Map(rows.map((row) => [row.id, row]))
  const canonicalIds: string[] = []
  for (const message of messages) {
    const state = stateById.get(message.id)
    if (!state) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    if (state.content_storage_state === 'legacy') continue
    if (!['canonical-backed-dual-write', 'canonical-backed-only'].includes(state.content_storage_state) || state.write_mode !== 'canonical') {
      throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    }
    canonicalIds.push(message.id)
  }
  return canonicalIds
}

function overlayPreparedBodies(messages: readonly Message[], canonicalIds: readonly string[], bodies: PreparedChatBodySelection): Message[] {
  const canonicalIdSet = new Set(canonicalIds)
  const bodyById = new Map(bodies.messages.map((message) => [message.id, message]))
  return messages.map((message) => {
    if (!canonicalIdSet.has(message.id)) return message
    const canonical = bodyById.get(message.id)
    if (!canonical || canonical.role !== message.role || canonical.timestamp !== message.timestamp) {
      throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    }
    return { ...message, content: canonical.content }
  })
}

function getTurnByAssistant(db: AppDatabase, sessionId: string, assistantMessageId: string): { requestId: string; turnId: string } | undefined {
  return getDbConnection(db).prepare('SELECT request_id AS requestId, turn_id AS turnId FROM turns WHERE session_id=? AND assistant_message_id=?').get(sessionId, assistantMessageId) as { requestId: string; turnId: string } | undefined
}

function attachTurnIdentity<T extends { failedAssistant: { message: { id: string } } }>(db: AppDatabase, sessionId: string, target: T): T & { sourceInvocationId?: string; sourceTurnId?: string } {
  const turn = getTurnByAssistant(db, sessionId, target.failedAssistant.message.id)
  return { ...target, ...(turn ? { sourceInvocationId: turn.requestId, sourceTurnId: turn.turnId } : {}) }
}

export function createSessionQueries(db: AppDatabase, preparedChatBody?: Readonly<{
  currentSourceIdentity(sessionId: string, sessionGeneration: string): string | undefined
  readBodies(view: PreparedChatBodyView, messageIds: readonly string[]): Promise<PreparedChatBodySelection>
  invalidate(view: PreparedChatBodyView): void
}>): SessionQueries {
  const queries: SessionQueries = {
    continuationSources: inspectContinuationSources(db),
    readSession: (sessionId) => getSession(db, sessionId),
    readSessionUsage: (sessionId) => getSessionUsage(db, sessionId),
    listSessions: (options) => listSessions(db, options),
    readMessage: ({ sessionId, messageId }: MessageRef) => {
      const message = getProjectedMessage(db, messageId)
      return message?.sessionId === sessionId ? message : undefined
    },
    readMessages: ({ sessionId, limit, offset }) => getProjectedMessages(db, sessionId, limit, offset),
    ...(preparedChatBody ? { readPreparedMessages: async ({ sessionId, limit, offset, prepared }) => {
      const view = prepared as PreparedChatBodyView | undefined
      if (!view) return undefined
      const selected = runInTransaction(getDbConnection(db), () => {
        const currentIdentity = preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration)
        if (currentIdentity !== view.sourceIdentityJson) return undefined
        const raw = getMessages(db, sessionId, limit ?? 500, offset ?? 0)
        if (raw.length === 0) return { messages: raw, canonicalIds: [] as string[] }
        return { messages: raw, canonicalIds: canonicalBodyMessageIds(db, sessionId, raw) }
      })
      if (!selected) return undefined
      if (selected.canonicalIds.length === 0) return selected.messages
      let bodies: PreparedChatBodySelection
      try { bodies = await preparedChatBody.readBodies(view, selected.canonicalIds) }
      catch {
        preparedChatBody.invalidate(view)
        return undefined
      }
      return runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const latest = getMessages(db, sessionId, limit ?? 500, offset ?? 0)
        if (latest.length !== selected.messages.length || latest.some((message, index) => message.id !== selected.messages[index]?.id)) return undefined
        return overlayPreparedBodies(latest, selected.canonicalIds, bodies)
      })
    } } : {}),
    ...(preparedChatBody ? { readPreparedChatPage: async ({ sessionId, beforeSequence, limit, prepared }) => {
      const view = prepared as PreparedChatBodyView | undefined
      if (!view) return undefined
      const selected = runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const page = getChatMessagePage(db, sessionId, beforeSequence, limit)
        if (page.entries.length === 0) return { page, canonicalIds: [] as string[] }
        return { page, canonicalIds: canonicalBodyMessageIds(db, sessionId, page.entries.map(({ message }) => message)) }
      })
      if (!selected) return undefined
      if (selected.canonicalIds.length === 0) return { ...selected.page,
        entries: projectMessageEntriesV1('chatMessageV1', selected.page.entries) }
      let bodies: PreparedChatBodySelection
      try { bodies = await preparedChatBody.readBodies(view, selected.canonicalIds) }
      catch {
        preparedChatBody.invalidate(view)
        return undefined
      }
      return runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const latest = getChatMessagePage(db, sessionId, beforeSequence, limit)
        if (latest.oldestSequence !== selected.page.oldestSequence || latest.hasMoreBefore !== selected.page.hasMoreBefore ||
          latest.entries.length !== selected.page.entries.length || latest.entries.some((entry, index) => {
            const prior = selected.page.entries[index]
            return !prior || entry.sequence !== prior.sequence || entry.message.id !== prior.message.id ||
              entry.message.role !== prior.message.role || entry.message.timestamp !== prior.message.timestamp
          })) return undefined
        const messages = overlayPreparedBodies(latest.entries.map(({ message }) => message), selected.canonicalIds, bodies)
        const entries = latest.entries.map((entry, index) => ({ ...entry, message: messages[index]! }))
        return { ...latest, entries: projectMessageEntriesV1('chatMessageV1', entries) }
      })
    } } : {}),
    ...(preparedChatBody ? { readPreparedApiBaseline: async ({ sessionId, limit, prepared }) => {
      const view = prepared as PreparedChatBodyView | undefined
      if (!view) return undefined
      const selected = runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const baseline = getApiContextBaseline(db, sessionId, limit ?? 500)
        return { baseline, canonicalIds: canonicalBodyMessageIds(db, sessionId, baseline.entries.map(({ message }) => message)) }
      })
      if (!selected) return undefined
      if (selected.canonicalIds.length === 0) return { ...selected.baseline,
        entries: projectMessageEntriesV1('apiBaselineV1', selected.baseline.entries) }
      let bodies: PreparedChatBodySelection
      try { bodies = await preparedChatBody.readBodies(view, selected.canonicalIds) }
      catch {
        preparedChatBody.invalidate(view)
        return undefined
      }
      return runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const latest = getApiContextBaseline(db, sessionId, limit ?? 500)
        if (latest.entries.length !== selected.baseline.entries.length || latest.entries.some((entry, index) => {
          const prior = selected.baseline.entries[index]
          return !prior || entry.sequence !== prior.sequence || entry.message.id !== prior.message.id ||
            entry.message.role !== prior.message.role || entry.message.timestamp !== prior.message.timestamp
        })) return undefined
        const messages = overlayPreparedBodies(latest.entries.map(({ message }) => message), selected.canonicalIds, bodies)
        const entries = latest.entries.map((entry, index) => ({ ...entry, message: messages[index]! }))
        return { ...latest, entries: projectMessageEntriesV1('apiBaselineV1', entries) }
      })
    } } : {}),
    ...(preparedChatBody ? { readPreparedSearchCorpusPage: async ({ sessionId, fromSequence, pageSize, prepared }) => {
      const view = prepared as PreparedChatBodyView | undefined
      if (!view) return undefined
      const select = () => getProjectedSearchCorpusPage(db, sessionId, fromSequence, pageSize)
      const selected = runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const page = select()
        return { page, canonicalIds: canonicalBodyMessageIds(db, sessionId, page.entries.map(({ message }) => message)) }
      })
      if (!selected) return undefined
      if (selected.canonicalIds.length === 0) return { ...selected.page, entries: projectMessageEntriesV1('searchCorpusV1', selected.page.entries) }
      let bodies: PreparedChatBodySelection
      try { bodies = await preparedChatBody.readBodies(view, selected.canonicalIds) }
      catch {
        preparedChatBody.invalidate(view)
        return undefined
      }
      return runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const latest = select()
        if (latest.nextSequence !== selected.page.nextSequence || latest.hasMore !== selected.page.hasMore ||
          latest.entries.length !== selected.page.entries.length || latest.entries.some((entry, index) => {
            const prior = selected.page.entries[index]
            return !prior || entry.sequence !== prior.sequence || entry.message.id !== prior.message.id ||
              entry.message.role !== prior.message.role || entry.message.timestamp !== prior.message.timestamp
          })) return undefined
        const messages = overlayPreparedBodies(latest.entries.map(({ message }) => message), selected.canonicalIds, bodies)
        const entries = latest.entries.map((entry, index) => ({ ...entry, message: messages[index]! }))
        return { ...latest, entries: projectMessageEntriesV1('searchCorpusV1', entries) }
      })
    } } : {}),
    ...(preparedChatBody ? { readPreparedExportPage: async ({ sessionId, fromSequence, pageSize, prepared }) => {
      const view = prepared as PreparedChatBodyView | undefined
      if (!view) return undefined
      const select = () => getProjectedMessagesPageWithSequence(db, sessionId, fromSequence, pageSize)
      const selected = runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const page = select()
        return { page, canonicalIds: canonicalBodyMessageIds(db, sessionId, page.rows.map(({ message }) => message)) }
      })
      if (!selected) return undefined
      if (selected.canonicalIds.length === 0) return { ...selected.page, rows: projectMessageEntriesV1('exportMessageV1', selected.page.rows) }
      let bodies: PreparedChatBodySelection
      try { bodies = await preparedChatBody.readBodies(view, selected.canonicalIds) }
      catch {
        preparedChatBody.invalidate(view)
        return undefined
      }
      return runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const latest = select()
        if (latest.nextSequence !== selected.page.nextSequence || latest.rows.length !== selected.page.rows.length || latest.rows.some((entry, index) => {
          const prior = selected.page.rows[index]
          return !prior || entry.sequence !== prior.sequence || entry.message.id !== prior.message.id ||
            entry.message.role !== prior.message.role || entry.message.timestamp !== prior.message.timestamp
        })) return undefined
        const messages = overlayPreparedBodies(latest.rows.map(({ message }) => message), selected.canonicalIds, bodies)
        const rows = latest.rows.map((entry, index) => ({ ...entry, message: messages[index]! }))
        return { ...latest, rows: projectMessageEntriesV1('exportMessageV1', rows) }
      })
    } } : {}),
    ...(preparedChatBody ? { readPreparedRetryTarget: async ({ sessionId, failedAssistantMessageId, prepared }) => {
      const view = prepared as PreparedChatBodyView | undefined
      if (!view) return undefined
      const select = () => {
        if (failedAssistantMessageId) {
          const target = resolveProjectedRetryContext(db, sessionId, failedAssistantMessageId)
          return target ? attachTurnIdentity(db, sessionId, target) as ReturnType<SessionQueries['readRetryTarget']> : null
        }
        const failed = getProjectedMessages(db, sessionId).filter((item) => item.role === 'assistant' && item.status === 'failed')
        if (failed.length > 1) return null
        const message = failed.at(-1)
        const target = message ? resolveProjectedRetryContext(db, sessionId, message.id) : null
        return target ? attachTurnIdentity(db, sessionId, target) : null
      }
      const selected = runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const target = select()
        if (!target) return { target, canonicalIds: [] as string[] }
        const messages = [target.failedAssistant.message, target.currentUser.message]
        return { target, canonicalIds: canonicalBodyMessageIds(db, sessionId, messages) }
      })
      if (!selected) return undefined
      if (!selected.target || selected.canonicalIds.length === 0) return selected.target
      let bodies: PreparedChatBodySelection
      try { bodies = await preparedChatBody.readBodies(view, selected.canonicalIds) }
      catch {
        preparedChatBody.invalidate(view)
        return undefined
      }
      return runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const latest = select()
        const prior = selected.target!
        if (!latest || latest.failedAssistant.sequence !== prior.failedAssistant.sequence || latest.currentUser.sequence !== prior.currentUser.sequence ||
          latest.failedAssistant.message.id !== prior.failedAssistant.message.id || latest.currentUser.message.id !== prior.currentUser.message.id ||
          latest.failedAssistant.message.role !== prior.failedAssistant.message.role || latest.currentUser.message.role !== prior.currentUser.message.role ||
          latest.failedAssistant.message.timestamp !== prior.failedAssistant.message.timestamp || latest.currentUser.message.timestamp !== prior.currentUser.message.timestamp ||
          latest.excludeMessageIds.length !== prior.excludeMessageIds.length || latest.excludeMessageIds.some((id, index) => id !== prior.excludeMessageIds[index]) ||
          latest.sourceInvocationId !== prior.sourceInvocationId || latest.sourceTurnId !== prior.sourceTurnId) return undefined
        const messages = overlayPreparedBodies([latest.failedAssistant.message, latest.currentUser.message], selected.canonicalIds, bodies)
        return { ...latest,
          failedAssistant: { ...latest.failedAssistant, message: messages[0]! },
          currentUser: { ...latest.currentUser, message: messages[1]! } }
      })
    } } : {}),
    readChatPage: ({ sessionId, beforeSequence, limit }) => {
      const page = getProjectedChatMessagePage(db, sessionId, beforeSequence, limit)
      return { ...page, entries: projectMessageEntriesV1('chatMessageV1', page.entries) }
    },
    readTurnContext: ({ sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds = [] }) =>
      getProjectedTurnContext(db, sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds),
    readApiBaseline: ({ sessionId, limit }) => {
      const baseline = limit === undefined ? getProjectedApiContextBaseline(db, sessionId) : getProjectedApiContextBaseline(db, sessionId, limit)
      return { ...baseline, entries: projectMessageEntriesV1('apiBaselineV1', baseline.entries) }
    },
    readContextHistorySummaryBaseline: (sessionId) => getContextHistorySummaryBaseline(db, sessionId),
    readCanonicalCompactionReplay: (sessionId) => new SqliteAgentHistory(getDbConnection(db), 1, Date.now, sessionId).readCanonicalCompactionReplay(sessionId),
    readCanonicalContextMeterEvents: (sessionId) => new SqliteAgentHistory(getDbConnection(db), 1, Date.now, sessionId).readCanonicalContextMeterEvents(sessionId),
    ...createRoutingQueries(db),
    readExportPage: ({ sessionId, fromSequence, pageSize }) => {
      const page = getProjectedMessagesPageWithSequence(db, sessionId, fromSequence, pageSize)
      return { ...page, rows: projectMessageEntriesV1('exportMessageV1', page.rows) }
    },
    readSearchCorpusPage: ({ sessionId, fromSequence, pageSize }) => {
      const page = getProjectedSearchCorpusPage(db, sessionId, fromSequence, pageSize)
      return { ...page, entries: projectMessageEntriesV1('searchCorpusV1', page.entries) }
    },
    searchMessages: ({ query, activeProfileId, limit }) => searchProjectedMessages(db, query, activeProfileId, limit),
    readRetryTarget: ({ sessionId, failedAssistantMessageId }) => {
      const target = resolveProjectedRetryContext(db, sessionId, failedAssistantMessageId)
      return target ? attachTurnIdentity(db, sessionId, target) as ReturnType<SessionQueries['readRetryTarget']> : null
    },
    readLatestRetryTarget: (sessionId) => {
      const failed = getProjectedMessages(db, sessionId).filter((item) => item.role === 'assistant' && item.status === 'failed')
      if (failed.length > 1) return null
      const message = failed.at(-1)
      const target = message ? resolveProjectedRetryContext(db, sessionId, message.id) : null
      return target ? attachTurnIdentity(db, sessionId, target) : null
    },
    readMessageSequence: ({ sessionId, messageId }) => getMessageSequence(db, sessionId, messageId),
    readTurnByRequest: ({ sessionId, requestId }) => getTurnByRequestId(db, sessionId, requestId),
    listTurnErrorsByAssistantMessageIds: (assistantMessageIds) => listTurnErrorsByAssistantMessageIds(db, assistantMessageIds)
  }
  return Object.freeze(queries)
}
