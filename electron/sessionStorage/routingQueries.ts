import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import {
  getMessage,
  getRecentTurnRoutingMessageCandidatePage,
  getSessionMessageRevisionSnapshot,
  hasVisionInTurnRoutingContext,
  type SessionMessageRevisionSnapshot
} from '../database/operations'
import { getProjectedMessage, getProjectedRecentTurnRoutingMessages } from '../runtime/sessionTranscriptProjection'
import {
  isCanonicalApiReadFenceCurrent,
  readCanonicalTurnRoutingInputWithFenceIfEligible,
  type CanonicalApiReadFence
} from './certification'
import { shadowTurnRoutingInput } from '../runtime/sessionStorageShadow'
import type { RouteInput, RoutingRead, SelectionFence } from './public/model'
import type { PreparedChatBodyView } from './public/model'
import type { SessionQueries } from './public/ports'
import type { PreparedChatBodySelection } from './infrastructure/sqlite/projectionChatBodyCacheWorkerClient'

type IssuedSelection = Readonly<{
  sessionId: string
  messageSnapshot: SessionMessageRevisionSnapshot
  boundarySequence?: number
  excludeMessageIds: string[]
  limit?: number
  reuseUserMessageId?: string
  canonicalFence?: CanonicalApiReadFence
  preparedSourceIdentityJson?: string
}>

type PreparedRouteBodyReader = Readonly<{
  currentSourceIdentity(sessionId: string, sessionGeneration: string): string | undefined
  readBodies(view: PreparedChatBodyView, messageIds: readonly string[], signal?: AbortSignal): Promise<PreparedChatBodySelection>
  invalidate(view: PreparedChatBodyView): void
}>

/** Keep route selection, canonical resolution and its await-boundary fence in one query adapter. */
export function createRoutingQueries(
  db: AppDatabase,
  preparedBodyReader?: PreparedRouteBodyReader
): Pick<SessionQueries, 'readRoutingInput' | 'readPreparedRoutingInput' | 'resolveRoutingInput' | 'isSelectionCurrent' | 'readSelectionSnapshot'> {
  const issuedSelectionFences = new WeakMap<object, IssuedSelection>()
  const queries: Pick<SessionQueries, 'readRoutingInput' | 'resolveRoutingInput' | 'isSelectionCurrent' | 'readSelectionSnapshot'> = {
    readRoutingInput: ({ sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds = [], limit, reuseUserMessageId, userInput: providedUserInput }) => {
      const messageSnapshot = getSessionMessageRevisionSnapshot(db, sessionId)
      if (!messageSnapshot) throw new Error('TURN_SESSION_NOT_FOUND')
      const selectedUser = reuseUserMessageId ?? requiredUserMessageId
      const selectedMessage = selectedUser ? getProjectedMessage(db, selectedUser) : undefined
      const userInput = reuseUserMessageId
        ? (selectedMessage?.sessionId === sessionId ? selectedMessage.content : undefined)
        : providedUserInput ?? (selectedMessage?.sessionId === sessionId ? selectedMessage.content : undefined)
      if ((reuseUserMessageId || requiredUserMessageId) && userInput === undefined) throw new Error('TURN_USER_MESSAGE_MISSING')
      const routeInput: {
        userInput?: string
        recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>
      } = {
        ...(userInput !== undefined ? { userInput } : {}),
        recentMessages: getProjectedRecentTurnRoutingMessages(db, sessionId, limit, boundarySequence, excludeMessageIds)
      }
      const fence = Object.freeze({}) as SelectionFence
      issuedSelectionFences.set(fence, {
        sessionId, messageSnapshot, boundarySequence, excludeMessageIds: [...excludeMessageIds], limit,
        ...(reuseUserMessageId ? { reuseUserMessageId } : {})
      })
      const read: RoutingRead = {
        recentMessages: routeInput.recentMessages,
        ...(routeInput.userInput !== undefined ? { userInput: routeInput.userInput } : {}),
        hasVision: hasVisionInTurnRoutingContext(db, sessionId, boundarySequence, excludeMessageIds),
        fence
      }
      return read
    },
    ...(preparedBodyReader ? { readPreparedRoutingInput: async (input: {
      sessionId: string; boundarySequence?: number; requiredUserMessageId?: string; excludeMessageIds?: string[]
      limit?: number; reuseUserMessageId?: string; userInput?: string; prepared?: PreparedChatBodyView; signal?: AbortSignal
    }): Promise<RoutingRead | undefined> => {
      const view = input.prepared
      if (!view || view.sessionId !== input.sessionId) return undefined
      const sourceIdentityJson = preparedBodyReader.currentSourceIdentity(input.sessionId, view.sessionGeneration)
      if (!sourceIdentityJson || sourceIdentityJson !== view.sourceIdentityJson) return undefined
      const messageSnapshot = getSessionMessageRevisionSnapshot(db, input.sessionId)
      if (!messageSnapshot) throw new Error('TURN_SESSION_NOT_FOUND')
      const selectedUserId = input.reuseUserMessageId ?? input.requiredUserMessageId
      const selectedUser = selectedUserId ? getMessage(db, selectedUserId) : undefined
      if (selectedUserId && selectedUser?.sessionId !== input.sessionId) throw new Error('TURN_USER_MESSAGE_MISSING')
      const selectedUserState = selectedUserId ? getDbConnection(db).prepare(`SELECT m.content_storage_state AS contentStorageState,
        cutover.write_mode AS writeMode FROM messages m LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=m.session_id
        WHERE m.session_id=? AND m.id=?`).get(input.sessionId, selectedUserId) as
          { contentStorageState: string; writeMode: string | null } | undefined : undefined

      const canonicalBodyById = new Map<string, Readonly<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>>()
      const readCanonicalBodies = async (ids: readonly string[]): Promise<boolean> => {
        if (ids.length === 0) return true
        let result: PreparedChatBodySelection
        try { result = await preparedBodyReader.readBodies(view, ids, input.signal) }
        catch (error) {
          if (input.signal?.aborted) throw error
          preparedBodyReader.invalidate(view)
          return false
        }
        const byId = new Map(result.messages.map((message) => [message.id, message]))
        if (byId.size !== ids.length || ids.some((id) => !byId.has(id))) {
          preparedBodyReader.invalidate(view)
          return false
        }
        for (const message of result.messages) {
          if (message.role !== 'user' && message.role !== 'assistant') return false
          canonicalBodyById.set(message.id, message)
        }
        return preparedBodyReader.currentSourceIdentity(input.sessionId, view.sessionGeneration) === sourceIdentityJson
      }

      const routeLimit = input.limit ?? 50
      const recentDescending: Array<{ role: 'user' | 'assistant'; content: string }> = []
      let cursor: import('../database/operations').RecentTurnRoutingMessageCursor | undefined
      try {
        if (routeLimit !== 0) {
          do {
            const page = getRecentTurnRoutingMessageCandidatePage(db, { sessionId: input.sessionId,
              boundarySequence: input.boundarySequence, excludeMessageIds: input.excludeMessageIds, cursor, pageSize: 64 })
            const canonicalIds: string[] = []
            for (const candidate of page.candidates) {
              if (candidate.contentStorageState === 'legacy') continue
              if (!['canonical-backed-dual-write', 'canonical-backed-only'].includes(candidate.contentStorageState) || candidate.writeMode !== 'canonical') {
                return undefined
              }
              canonicalIds.push(candidate.message.id)
            }
            if (!await readCanonicalBodies(canonicalIds)) return undefined
            for (const candidate of page.candidates) {
              let content: string
              if (candidate.contentStorageState === 'legacy') content = candidate.message.content
              else {
                const canonical = canonicalBodyById.get(candidate.message.id)
                if (!canonical || canonical.role !== candidate.message.role || canonical.timestamp !== candidate.message.timestamp) return undefined
                content = canonical.content
              }
              if (content.trim()) {
                recentDescending.push({ role: candidate.message.role as 'user' | 'assistant', content })
                if (routeLimit > 0 && recentDescending.length >= routeLimit) break
              }
            }
            if (routeLimit > 0 && recentDescending.length >= routeLimit) break
            cursor = page.nextCursor
            if (page.candidates.length === 0 || !cursor) break
          } while (true)
        }

        let resolvedUserInput: string | undefined
        if (selectedUserId) {
          const state = selectedUserState?.contentStorageState
          if (state === 'legacy') resolvedUserInput = input.reuseUserMessageId || input.userInput === undefined
            ? selectedUser?.content : input.userInput
          else if (state && ['canonical-backed-dual-write', 'canonical-backed-only'].includes(state) && selectedUserState?.writeMode === 'canonical') {
            if (!canonicalBodyById.has(selectedUserId) && !await readCanonicalBodies([selectedUserId])) return undefined
            const body = canonicalBodyById.get(selectedUserId)
            if (!body || body.role !== selectedUser!.role || body.timestamp !== selectedUser!.timestamp) return undefined
            resolvedUserInput = input.reuseUserMessageId || input.userInput === undefined ? body.content : input.userInput
          } else return undefined
        } else resolvedUserInput = input.userInput
        if ((input.reuseUserMessageId || input.requiredUserMessageId) && resolvedUserInput === undefined) throw new Error('TURN_USER_MESSAGE_MISSING')

        if (preparedBodyReader.currentSourceIdentity(input.sessionId, view.sessionGeneration) !== sourceIdentityJson) return undefined
        const latestSnapshot = getSessionMessageRevisionSnapshot(db, input.sessionId)
        if (!latestSnapshot || latestSnapshot.generation !== messageSnapshot.generation || latestSnapshot.messageRevision !== messageSnapshot.messageRevision) return undefined
        const fence = Object.freeze({}) as SelectionFence
        issuedSelectionFences.set(fence, { sessionId: input.sessionId, messageSnapshot, boundarySequence: input.boundarySequence,
          excludeMessageIds: [...(input.excludeMessageIds ?? [])], limit: input.limit,
          ...(input.reuseUserMessageId ? { reuseUserMessageId: input.reuseUserMessageId } : {}),
          preparedSourceIdentityJson: sourceIdentityJson })
        const hasUserImage = input.reuseUserMessageId && selectedUser?.attachments?.some(({ mimeType }) => mimeType?.startsWith('image/'))
        return { recentMessages: recentDescending.reverse(), ...(resolvedUserInput !== undefined ? { userInput: resolvedUserInput } : {}),
          hasVision: Boolean(hasUserImage || hasVisionInTurnRoutingContext(db, input.sessionId, input.boundarySequence, input.excludeMessageIds)), fence }
      } catch (error) {
        if (input.signal?.aborted) throw error
        if (error instanceof Error && error.message === 'TURN_USER_MESSAGE_MISSING') throw error
        return undefined
      }
    } } : {}),
    resolveRoutingInput: <T extends RouteInput>({ sessionId, selection, routeInput }: { sessionId: string; selection: SelectionFence; routeInput: T }) => {
      const issued = issuedSelectionFences.get(selection as object)
      if (!issued || issued.sessionId !== sessionId || !queries.isSelectionCurrent(sessionId, selection)) {
        throw new Error('TURN_CONTEXT_CHANGED_DURING_PREPARATION')
      }
      if (issued.preparedSourceIdentityJson) {
        const fence = Object.freeze({}) as SelectionFence
        issuedSelectionFences.set(fence, issued)
        return { routeInput, fence }
      }
      try {
        shadowTurnRoutingInput(db, {
          sessionId,
          mode: issued.reuseUserMessageId ? 'reuse-user' : 'create-user',
          ...(issued.reuseUserMessageId ? { reuseUserMessageId: issued.reuseUserMessageId } : {}),
          routeInput,
          boundarySequence: issued.boundarySequence,
          excludeMessageIds: issued.excludeMessageIds,
          limit: issued.limit
        })
      } catch {
        // Shadow comparison is observational and never controls the live route.
      }
      let resolvedRouteInput = routeInput
      let canonicalFence: CanonicalApiReadFence | undefined
      try {
        const canonical = readCanonicalTurnRoutingInputWithFenceIfEligible(db, {
          sessionId,
          mode: issued.reuseUserMessageId ? 'reuse-user' : 'create-user',
          ...(issued.reuseUserMessageId ? { reuseUserMessageId: issued.reuseUserMessageId } : {}),
          routeInput,
          boundarySequence: issued.boundarySequence,
          excludeMessageIds: issued.excludeMessageIds,
          limit: issued.limit
        })
        if (canonical) {
          resolvedRouteInput = canonical.routeInput
          canonicalFence = canonical.fence
        }
      } catch {
        // Preserve the established complete legacy fallback on canonical read failure.
      }
      const fence = Object.freeze({}) as SelectionFence
      issuedSelectionFences.set(fence, { ...issued, ...(canonicalFence ? { canonicalFence } : {}) })
      return { routeInput: resolvedRouteInput, fence }
    },
    isSelectionCurrent: (sessionId, fence) => {
      const issued = issuedSelectionFences.get(fence as object)
      if (!issued || issued.sessionId !== sessionId) return false
      if (issued.canonicalFence && !isCanonicalApiReadFenceCurrent(db, sessionId, issued.canonicalFence)) return false
      if (issued.preparedSourceIdentityJson && preparedBodyReader?.currentSourceIdentity(sessionId, issued.messageSnapshot.generation) !== issued.preparedSourceIdentityJson) return false
      const current = getSessionMessageRevisionSnapshot(db, sessionId)
      return current?.generation === issued.messageSnapshot.generation && current.messageRevision === issued.messageSnapshot.messageRevision
    },
    readSelectionSnapshot: (sessionId, fence) => {
      const issued = issuedSelectionFences.get(fence as object)
      if (!issued || issued.sessionId !== sessionId || !queries.isSelectionCurrent(sessionId, fence)) return undefined
      return issued.messageSnapshot
    }
  }
  return Object.freeze(queries)
}
