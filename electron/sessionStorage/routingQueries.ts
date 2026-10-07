import type { AppDatabase } from '../database/sqliteStore'
import {
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
import type { RouteInput, RoutingRead, SelectionFence, SessionQueries } from './contracts'

type IssuedSelection = Readonly<{
  sessionId: string
  messageSnapshot: SessionMessageRevisionSnapshot
  boundarySequence?: number
  excludeMessageIds: string[]
  limit?: number
  reuseUserMessageId?: string
  canonicalFence?: CanonicalApiReadFence
}>

/** Keep route selection, canonical resolution and its await-boundary fence in one query adapter. */
export function createRoutingQueries(
  db: AppDatabase
): Pick<SessionQueries, 'readRoutingInput' | 'resolveRoutingInput' | 'isSelectionCurrent' | 'readSelectionSnapshot'> {
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
    resolveRoutingInput: <T extends RouteInput>({ sessionId, selection, routeInput }: { sessionId: string; selection: SelectionFence; routeInput: T }) => {
      const issued = issuedSelectionFences.get(selection as object)
      if (!issued || issued.sessionId !== sessionId || !queries.isSelectionCurrent(sessionId, selection)) {
        throw new Error('TURN_CONTEXT_CHANGED_DURING_PREPARATION')
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
