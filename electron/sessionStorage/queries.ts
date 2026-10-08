import type { AppDatabase } from '../database/sqliteStore'
import {
  getSession,
  listSessions,
  getContextHistorySummaryBaseline,
  getMessageSequence,
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
import type { MessageRef, SessionQueries } from './contracts'
import { inspectContinuationSources } from './continuationSources'
import { createRoutingQueries } from './routingQueries'
import { getDbConnection } from '../database'

function getTurnByAssistant(db: AppDatabase, sessionId: string, assistantMessageId: string): { requestId: string; turnId: string } | undefined {
  return getDbConnection(db).prepare('SELECT request_id AS requestId, turn_id AS turnId FROM turns WHERE session_id=? AND assistant_message_id=?').get(sessionId, assistantMessageId) as { requestId: string; turnId: string } | undefined
}

export function createSessionQueries(db: AppDatabase): SessionQueries {
  const queries: SessionQueries = {
    continuationSources: inspectContinuationSources(db),
    readSession: (sessionId) => getSession(db, sessionId),
    listSessions: (options) => listSessions(db, options),
    readMessage: ({ sessionId, messageId }: MessageRef) => {
      const message = getProjectedMessage(db, messageId)
      return message?.sessionId === sessionId ? message : undefined
    },
    readMessages: ({ sessionId, limit, offset }) => getProjectedMessages(db, sessionId, limit, offset),
    readChatPage: ({ sessionId, beforeSequence, limit }) => getProjectedChatMessagePage(db, sessionId, beforeSequence, limit),
    readTurnContext: ({ sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds = [] }) =>
      getProjectedTurnContext(db, sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds),
    readApiBaseline: ({ sessionId, limit }) => limit === undefined
      ? getProjectedApiContextBaseline(db, sessionId)
      : getProjectedApiContextBaseline(db, sessionId, limit),
    readContextHistorySummaryBaseline: (sessionId) => getContextHistorySummaryBaseline(db, sessionId),
    ...createRoutingQueries(db),
    readExportPage: ({ sessionId, fromSequence, pageSize }) =>
      getProjectedMessagesPageWithSequence(db, sessionId, fromSequence, pageSize),
    readSearchCorpusPage: ({ sessionId, fromSequence, pageSize }) =>
      getProjectedSearchCorpusPage(db, sessionId, fromSequence, pageSize),
    searchMessages: ({ query, activeProfileId, limit }) => searchProjectedMessages(db, query, activeProfileId, limit),
    readRetryTarget: ({ sessionId, failedAssistantMessageId }) => {
      const target = resolveProjectedRetryContext(db, sessionId, failedAssistantMessageId)
      return target as ReturnType<SessionQueries['readRetryTarget']>
    },
    readLatestRetryTarget: (sessionId) => {
      const failed = getProjectedMessages(db, sessionId).filter((item) => item.role === 'assistant' && item.status === 'failed')
      if (failed.length > 1) return null
      const message = failed.at(-1)
      const target = message ? resolveProjectedRetryContext(db, sessionId, message.id) : null
      const turn = target ? getTurnByAssistant(db, sessionId, target.failedAssistant.message.id) : undefined
      return target ? { ...target, ...(turn ? { sourceInvocationId: turn.requestId, sourceTurnId: turn.turnId } : {}) } : null
    },
    readMessageSequence: ({ sessionId, messageId }) => getMessageSequence(db, sessionId, messageId)
  }
  return Object.freeze(queries)
}
