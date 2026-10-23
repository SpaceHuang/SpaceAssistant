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

function getTurnByAssistant(db: AppDatabase, sessionId: string, assistantMessageId: string): { requestId: string; turnId: string } | undefined {
  return getDbConnection(db).prepare('SELECT request_id AS requestId, turn_id AS turnId FROM turns WHERE session_id=? AND assistant_message_id=?').get(sessionId, assistantMessageId) as { requestId: string; turnId: string } | undefined
}

function attachTurnIdentity<T extends { failedAssistant: { message: { id: string } } }>(db: AppDatabase, sessionId: string, target: T): T & { sourceInvocationId?: string; sourceTurnId?: string } {
  const turn = getTurnByAssistant(db, sessionId, target.failedAssistant.message.id)
  return { ...target, ...(turn ? { sourceInvocationId: turn.requestId, sourceTurnId: turn.turnId } : {}) }
}

export function createSessionQueries(db: AppDatabase, preparedChatBody?: Readonly<{
  currentSourceIdentity(sessionId: string, sessionGeneration: string): string | undefined
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
    ...(preparedChatBody ? { readPreparedMessages: ({ sessionId, limit, offset, prepared }) => {
      const view = prepared as PreparedChatBodyView | undefined
      if (!view) return undefined
      return runInTransaction(getDbConnection(db), () => {
        const currentIdentity = preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration)
        if (currentIdentity !== view.sourceIdentityJson) return undefined
        const raw = getMessages(db, sessionId, limit ?? 500, offset ?? 0)
        if (raw.length === 0) return []
        const ids = raw.map(({ id }) => id)
        const states = getDbConnection(db).prepare(`SELECT messages.id,messages.content_storage_state,cutover.write_mode
          FROM messages LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=messages.session_id
          WHERE messages.session_id=? AND messages.id IN (${ids.map(() => '?').join(',')})`).all(sessionId, ...ids) as
          Array<{ id: string; content_storage_state: string; write_mode: string | null }>
        const stateById = new Map(states.map((row) => [row.id, row]))
        const bodyById = new Map(view.messages.map((message) => [message.id, message]))
        const resolved = raw.map((message) => {
          const state = stateById.get(message.id)
          if (!state) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
          if (state.content_storage_state === 'legacy') return message
          if (!['canonical-backed-dual-write', 'canonical-backed-only'].includes(state.content_storage_state) || state.write_mode !== 'canonical') {
            throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
          }
          const canonical = bodyById.get(message.id)
          if (!canonical || canonical.role !== message.role || canonical.timestamp !== message.timestamp) {
            throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
          }
          return { ...message, content: canonical.content }
        })
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        return resolved
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
