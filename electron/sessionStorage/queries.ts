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
  getMessage,
  getMessageSkeleton,
  getChatMessagePage,
  getApiContextBaseline,
  resolveRetryContext as resolveStoredRetryContext,
} from '../database/operations'
import {
  getProjectedApiContextBaseline,
  getProjectedChatMessagePage,
  getProjectedMessage,
  getProjectedMessagesPageWithSequence,
  getProjectedMessages,
  getProjectedSearchCorpusPage,
  getProjectedTurnContext,
  selectTurnContextForPreparedRead,
  resolveProjectedRetryContext,
  searchProjectedMessages
} from './infrastructure/sqlite/sessionTranscriptProjection'
import type { SessionQueries } from './public/ports'
import type { MessageRef, MessageSearchHit, MessageSkeleton, RetryContextTarget } from './public/model'
import { inspectContinuationSources } from './continuationSources'
import { createRoutingQueries } from './routingQueries'
import { getDbConnection } from '../database/sqliteStore'
import { projectMessageEntriesV1 } from './domain/projectionSpec'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { runInTransaction } from '../database/transaction'
import type { PreparedChatBodyView } from './public/model'
import type { PreparedChatBodySelection } from './infrastructure/sqlite/projectionChatBodyCacheWorkerClient'
import type { PreparedChatBodySearch } from './infrastructure/sqlite/projectionChatBodyCacheWorkerClient'
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

class PreparedChatBodyMismatchError extends Error {}

function overlayPreparedBodies(messages: readonly Message[], canonicalIds: readonly string[], bodies: PreparedChatBodySelection): Message[] {
  const canonicalIdSet = new Set(canonicalIds)
  const bodyById = new Map(bodies.messages.map((message) => [message.id, message]))
  return messages.map((message) => {
    if (!canonicalIdSet.has(message.id)) return message
    const canonical = bodyById.get(message.id)
    if (!canonical || canonical.role !== message.role || canonical.timestamp !== message.timestamp) {
      throw new PreparedChatBodyMismatchError('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    }
    return { ...message, content: canonical.content }
  })
}

function tryOverlayPreparedBodies(
  messages: readonly Message[], canonicalIds: readonly string[], bodies: PreparedChatBodySelection, invalidate: () => void
): Message[] | undefined {
  try { return overlayPreparedBodies(messages, canonicalIds, bodies) }
  catch (error) {
    if (!(error instanceof PreparedChatBodyMismatchError)) throw error
    invalidate()
    return undefined
  }
}

function propagatePreparedReadCancellation(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? error
  if (error instanceof Error && (error.name === 'AbortError' || /(?:^|_)WORKER_(?:ABORTED|CANCELLED)$/.test(error.message))) throw error
}

function getTurnByAssistant(db: AppDatabase, sessionId: string, assistantMessageId: string): { requestId: string; turnId: string } | undefined {
  return getDbConnection(db).prepare('SELECT request_id AS requestId, turn_id AS turnId FROM turns WHERE session_id=? AND assistant_message_id=?').get(sessionId, assistantMessageId) as { requestId: string; turnId: string } | undefined
}

function attachTurnIdentity<T extends { failedAssistant: { message: { id: string } } }>(db: AppDatabase, sessionId: string, target: T): T & { sourceInvocationId?: string; sourceTurnId?: string } {
  const turn = getTurnByAssistant(db, sessionId, target.failedAssistant.message.id)
  return { ...target, ...(turn ? { sourceInvocationId: turn.requestId, sourceTurnId: turn.turnId } : {}) }
}

function selectUniqueFailedAssistantMessageId(db: AppDatabase, sessionId: string): string | null {
  const row = getDbConnection(db).prepare(`SELECT COUNT(*) AS count, MIN(id) AS id FROM messages
    WHERE session_id=? AND role='assistant' AND status='failed'`).get(sessionId) as { count: number; id: string | null }
  return row.count === 1 ? row.id : null
}

export function createSessionQueries(db: AppDatabase, preparedChatBody?: Readonly<{
  currentSourceIdentity(sessionId: string, sessionGeneration: string): string | undefined
  readBodies(view: PreparedChatBodyView, messageIds: readonly string[], signal?: AbortSignal): Promise<PreparedChatBodySelection>
  searchBodies(view: PreparedChatBodyView, query: string, limit: number): Promise<PreparedChatBodySearch>
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
    readMessageSkeleton: ({ sessionId, messageId }: MessageRef): MessageSkeleton | undefined => {
      const skeleton = getMessageSkeleton(db, messageId)
      if (!skeleton || skeleton.sessionId !== sessionId) return undefined
      const sequence = getMessageSequence(db, sessionId, messageId)
      if (sequence === null) return undefined
      return { id: skeleton.id, sessionId: skeleton.sessionId, role: skeleton.role, timestamp: skeleton.timestamp,
        status: skeleton.status, sequence }
    },
    readMessages: ({ sessionId, limit, offset }) => getProjectedMessages(db, sessionId, limit, offset),
    countQueuedMessages: (sessionId) => Number(getDbConnection(db).prepare(`SELECT COUNT(*) AS count FROM messages
      WHERE session_id=? AND role='user' AND status='queued'`).get(sessionId)?.count ?? 0),
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
      catch (error) {
        propagatePreparedReadCancellation(error)
        preparedChatBody.invalidate(view)
        return undefined
      }
      return runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const latest = getMessages(db, sessionId, limit ?? 500, offset ?? 0)
        if (latest.length !== selected.messages.length || latest.some((message, index) => message.id !== selected.messages[index]?.id)) return undefined
        return tryOverlayPreparedBodies(latest, selected.canonicalIds, bodies, () => preparedChatBody.invalidate(view))
      })
    } } : {}),
    ...(preparedChatBody ? { readPreparedMessage: async ({ sessionId, messageId, prepared }) => {
      const view = prepared as PreparedChatBodyView | undefined
      if (!view) return undefined
      const selected = runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const skeleton = getMessageSkeleton(db, messageId)
        if (!skeleton || skeleton.sessionId !== sessionId) return { skeleton: undefined, canonicalIds: [] as string[] }
        return { skeleton, canonicalIds: canonicalBodyMessageIds(db, sessionId, [skeleton as Message]) }
      })
      if (!selected) return undefined
      if (!selected.skeleton) return undefined
      if (selected.canonicalIds.length === 0) return getMessage(db, messageId)
      let bodies: PreparedChatBodySelection
      try { bodies = await preparedChatBody.readBodies(view, selected.canonicalIds) }
      catch (error) {
        propagatePreparedReadCancellation(error)
        preparedChatBody.invalidate(view)
        return undefined
      }
      return runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const latest = getMessageSkeleton(db, messageId)
        if (!latest || latest.sessionId !== sessionId || latest.id !== selected.skeleton!.id ||
          latest.role !== selected.skeleton!.role || latest.timestamp !== selected.skeleton!.timestamp || latest.status !== selected.skeleton!.status) return undefined
        return tryOverlayPreparedBodies([latest as Message], selected.canonicalIds, bodies, () => preparedChatBody.invalidate(view))?.[0]
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
      catch (error) {
        propagatePreparedReadCancellation(error)
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
        const messages = tryOverlayPreparedBodies(latest.entries.map(({ message }) => message), selected.canonicalIds, bodies,
          () => preparedChatBody.invalidate(view))
        if (!messages) return undefined
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
      catch (error) {
        propagatePreparedReadCancellation(error)
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
        const messages = tryOverlayPreparedBodies(latest.entries.map(({ message }) => message), selected.canonicalIds, bodies,
          () => preparedChatBody.invalidate(view))
        if (!messages) return undefined
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
      catch (error) {
        propagatePreparedReadCancellation(error)
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
        const messages = tryOverlayPreparedBodies(latest.entries.map(({ message }) => message), selected.canonicalIds, bodies,
          () => preparedChatBody.invalidate(view))
        if (!messages) return undefined
        const entries = latest.entries.map((entry, index) => ({ ...entry, message: messages[index]! }))
        return { ...latest, entries: projectMessageEntriesV1('searchCorpusV1', entries) }
      })
    } } : {}),
    ...(preparedChatBody ? { readPreparedExportPage: async ({ sessionId, fromSequence, pageSize, prepared, signal }) => {
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
      try { bodies = await preparedChatBody.readBodies(view, selected.canonicalIds, signal) }
      catch (error) {
        propagatePreparedReadCancellation(error, signal)
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
        const messages = tryOverlayPreparedBodies(latest.rows.map(({ message }) => message), selected.canonicalIds, bodies,
          () => preparedChatBody.invalidate(view))
        if (!messages) return undefined
        const rows = latest.rows.map((entry, index) => ({ ...entry, message: messages[index]! }))
        return { ...latest, rows: projectMessageEntriesV1('exportMessageV1', rows) }
      })
    } } : {}),
    ...(preparedChatBody ? { readPreparedRetryTarget: async ({ sessionId, failedAssistantMessageId, prepared }) => {
      const view = prepared as PreparedChatBodyView | undefined
      if (!view) return undefined
      const select = () => {
        let selectedAssistantId = failedAssistantMessageId
        if (!selectedAssistantId) selectedAssistantId = selectUniqueFailedAssistantMessageId(db, sessionId) ?? undefined
        const target = selectedAssistantId
          ? resolveStoredRetryContext(db, sessionId, selectedAssistantId, { allowEmptyContent: true }) : null
        return target ? attachTurnIdentity(db, sessionId, target) : null
      }
      const hasRetryShape = (target: RetryContextTarget | null): target is RetryContextTarget =>
        Boolean(target && target.failedAssistant.message.sessionId === sessionId && target.failedAssistant.message.role === 'assistant' &&
          target.failedAssistant.message.status === 'failed' && target.currentUser.message.sessionId === sessionId && target.currentUser.message.role === 'user')
      const isUsable = (target: RetryContextTarget | null): target is RetryContextTarget =>
        hasRetryShape(target) && Boolean(target.currentUser.message.content.trim())
      const selected = runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const target = select()
        if (!hasRetryShape(target)) return { target: null, canonicalIds: [] as string[] }
        const messages = [target.failedAssistant.message, target.currentUser.message]
        return { target, canonicalIds: canonicalBodyMessageIds(db, sessionId, messages) }
      })
      if (!selected) return undefined
      if (!selected.target || selected.canonicalIds.length === 0) return isUsable(selected.target) ? selected.target : null
      let bodies: PreparedChatBodySelection
      try { bodies = await preparedChatBody.readBodies(view, selected.canonicalIds) }
      catch (error) {
        propagatePreparedReadCancellation(error)
        preparedChatBody.invalidate(view)
        return undefined
      }
      return runInTransaction(getDbConnection(db), () => {
        if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
        const latest = select()
        const prior = selected.target!
        if (!hasRetryShape(latest) || latest.failedAssistant.sequence !== prior.failedAssistant.sequence || latest.currentUser.sequence !== prior.currentUser.sequence ||
          latest.failedAssistant.message.id !== prior.failedAssistant.message.id || latest.currentUser.message.id !== prior.currentUser.message.id ||
          latest.failedAssistant.message.role !== prior.failedAssistant.message.role || latest.currentUser.message.role !== prior.currentUser.message.role ||
          latest.failedAssistant.message.timestamp !== prior.failedAssistant.message.timestamp || latest.currentUser.message.timestamp !== prior.currentUser.message.timestamp ||
          latest.excludeMessageIds.length !== prior.excludeMessageIds.length || latest.excludeMessageIds.some((id, index) => id !== prior.excludeMessageIds[index]) ||
          latest.sourceInvocationId !== prior.sourceInvocationId || latest.sourceTurnId !== prior.sourceTurnId) return undefined
        const messages = tryOverlayPreparedBodies([latest.failedAssistant.message, latest.currentUser.message], selected.canonicalIds, bodies,
          () => preparedChatBody.invalidate(view))
        if (!messages) return undefined
        const preparedTarget = { ...latest,
          failedAssistant: { ...latest.failedAssistant, message: messages[0]! },
          currentUser: { ...latest.currentUser, message: messages[1]! } }
        return isUsable(preparedTarget) ? preparedTarget : null
      })
    } } : {}),
    ...(preparedChatBody ? {
      isPreparedViewCurrent: ({ sessionId, prepared }) => prepared.sessionId === sessionId &&
        preparedChatBody.currentSourceIdentity(sessionId, prepared.sessionGeneration) === prepared.sourceIdentityJson,
      readPreparedTurnContext: async ({ sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds = [], prepared }) => {
        const view = prepared
        if (!view || view.sessionId !== sessionId) return undefined
        const select = () => selectTurnContextForPreparedRead(db, sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds)
        const selected = runInTransaction(getDbConnection(db), () => {
          if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
          const messages = select()
          return { messages, canonicalIds: canonicalBodyMessageIds(db, sessionId, messages) }
        })
        if (!selected) return undefined
        if (selected.canonicalIds.length === 0) return selected.messages
        let bodies: PreparedChatBodySelection
        try { bodies = await preparedChatBody.readBodies(view, selected.canonicalIds) }
        catch (error) {
          propagatePreparedReadCancellation(error)
          preparedChatBody.invalidate(view)
          return undefined
        }
        return runInTransaction(getDbConnection(db), () => {
          if (preparedChatBody.currentSourceIdentity(sessionId, view.sessionGeneration) !== view.sourceIdentityJson) return undefined
          const latest = select()
          if (latest.length !== selected.messages.length || latest.some((message, index) =>
            JSON.stringify(message) !== JSON.stringify(selected.messages[index]))) return undefined
          return tryOverlayPreparedBodies(latest, selected.canonicalIds, bodies, () => preparedChatBody.invalidate(view))
        })
      }
    } : {}),
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
    ...createRoutingQueries(db, preparedChatBody),
    readExportPage: ({ sessionId, fromSequence, pageSize }) => {
      const page = getProjectedMessagesPageWithSequence(db, sessionId, fromSequence, pageSize)
      return { ...page, rows: projectMessageEntriesV1('exportMessageV1', page.rows) }
    },
    readSearchCorpusPage: ({ sessionId, fromSequence, pageSize }) => {
      const page = getProjectedSearchCorpusPage(db, sessionId, fromSequence, pageSize)
      return { ...page, entries: projectMessageEntriesV1('searchCorpusV1', page.entries) }
    },
    ...(preparedChatBody ? {
      searchPreparedMessages: async ({ query, activeProfileId, limit = 50, prepareSession }) => {
        const q = query.trim()
        if (!q || limit === 0) return []
        const escaped = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
        const candidates = getDbConnection(db).prepare(`SELECT m.id,m.session_id,m.role,m.content,m.content_storage_state,
            cutover.write_mode,s.name AS session_name,m.timestamp
          FROM messages m JOIN sessions s ON s.id=m.session_id
          LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=m.session_id
          WHERE (m.content LIKE ? ESCAPE '\\' OR m.content_storage_state IN ('canonical-backed-dual-write','canonical-backed-only'))
            AND (s.work_dir_profile_id IS NULL OR s.work_dir_profile_id=?)
            AND (s.ownership IS NULL OR s.ownership!='internal')
          ORDER BY m.timestamp DESC`).all(`%${escaped}%`, activeProfileId) as Array<{
            id: string; session_id: string; role: Message['role']; content: string; content_storage_state: string;
            write_mode: string | null; session_name: string; timestamp: number
          }>
        const results: MessageSearchHit[] = []
        const searchedBySession = new Map<string, Map<string, PreparedChatBodySearch['messages'][number]>>()
        const visitedSources = new Map<string, { sessionGeneration: string; sourceIdentityJson: string }>()
        for (const candidate of candidates) {
          const canonicalBacked = ['canonical-backed-dual-write', 'canonical-backed-only'].includes(candidate.content_storage_state)
          let canonical: PreparedChatBodySearch['messages'][number] | undefined
          if (canonicalBacked) {
            if (candidate.write_mode !== 'canonical') throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
            let sessionMessages = searchedBySession.get(candidate.session_id)
            if (!sessionMessages) {
              const view = await prepareSession(candidate.session_id)
              if (!view) throw new Error('PREPARED_SEARCH_UNAVAILABLE')
              if (preparedChatBody.currentSourceIdentity(candidate.session_id, view.sessionGeneration) !== view.sourceIdentityJson) {
                throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
              }
              visitedSources.set(candidate.session_id, {
                sessionGeneration: view.sessionGeneration,
                sourceIdentityJson: view.sourceIdentityJson
              })
              let search: PreparedChatBodySearch
              try { search = await preparedChatBody.searchBodies(view, q, limit > 0 ? limit - results.length : Number.MAX_SAFE_INTEGER) }
              catch (error) {
                if (error instanceof Error && error.message === 'PROJECTION_SOURCE_SPILL_INDEX_UNAVAILABLE') {
                  throw new Error('PREPARED_SEARCH_UNAVAILABLE')
                }
                preparedChatBody.invalidate(view)
                throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
              }
              if (preparedChatBody.currentSourceIdentity(candidate.session_id, view.sessionGeneration) !== view.sourceIdentityJson) {
                throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
              }
              sessionMessages = new Map(search.messages.map((message) => [message.id, message]))
              searchedBySession.set(candidate.session_id, sessionMessages)
            }
            canonical = sessionMessages.get(candidate.id)
          }
          if (canonicalBacked && (!canonical || canonical.role !== candidate.role || canonical.timestamp !== candidate.timestamp)) continue
          results.push({ messageId: candidate.id, sessionId: candidate.session_id,
            content: canonical?.content ?? candidate.content, sessionName: candidate.session_name,
            ...(canonicalBacked ? { requiresProjectionPreparation: true } : {}) })
          if (limit > 0 && results.length >= limit) break
        }
        const sourceStillCurrent = runInTransaction(getDbConnection(db), () => {
          const latestCandidates = getDbConnection(db).prepare(`SELECT m.id,m.session_id,m.role,m.content,m.content_storage_state,
            cutover.write_mode,s.name AS session_name,m.timestamp
          FROM messages m JOIN sessions s ON s.id=m.session_id
          LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=m.session_id
          WHERE (m.content LIKE ? ESCAPE '\\' OR m.content_storage_state IN ('canonical-backed-dual-write','canonical-backed-only'))
            AND (s.work_dir_profile_id IS NULL OR s.work_dir_profile_id=?)
            AND (s.ownership IS NULL OR s.ownership!='internal')
            ORDER BY m.timestamp DESC`).all(`%${escaped}%`, activeProfileId) as typeof candidates
          if (latestCandidates.length !== candidates.length || latestCandidates.some((row, index) => {
            const prior = candidates[index]
            return !prior || row.id !== prior.id || row.session_id !== prior.session_id || row.role !== prior.role ||
              row.content !== prior.content || row.content_storage_state !== prior.content_storage_state || row.write_mode !== prior.write_mode ||
              row.session_name !== prior.session_name || row.timestamp !== prior.timestamp
          })) return false
          for (const [sessionId, source] of visitedSources) {
            if (preparedChatBody.currentSourceIdentity(sessionId, source.sessionGeneration) !== source.sourceIdentityJson) return false
          }
          return true
        })
        if (!sourceStillCurrent) throw new Error('GLOBAL_SEARCH_SOURCE_CHANGED')
        return results
      }
    } : {}),
    searchMessages: ({ query, activeProfileId, limit }) => searchProjectedMessages(db, query, activeProfileId, limit),
    readRetryTarget: ({ sessionId, failedAssistantMessageId }) => {
      const target = resolveProjectedRetryContext(db, sessionId, failedAssistantMessageId)
      return target ? attachTurnIdentity(db, sessionId, target) as ReturnType<SessionQueries['readRetryTarget']> : null
    },
    readLatestRetryTarget: (sessionId) => {
      const failedAssistantMessageId = selectUniqueFailedAssistantMessageId(db, sessionId)
      const target = failedAssistantMessageId ? resolveProjectedRetryContext(db, sessionId, failedAssistantMessageId) : null
      return target ? attachTurnIdentity(db, sessionId, target) : null
    },
    readMessageSequence: ({ sessionId, messageId }) => getMessageSequence(db, sessionId, messageId),
    readTurnByRequest: ({ sessionId, requestId }) => getTurnByRequestId(db, sessionId, requestId),
    listTurnErrorsByAssistantMessageIds: (assistantMessageIds) => listTurnErrorsByAssistantMessageIds(db, assistantMessageIds)
  }
  return Object.freeze(queries)
}
