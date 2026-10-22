import type { ProjectionHistoryReducerPort } from '../../application/projectionBuildCoordinator'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import { projectionScopeKind } from '../../domain/scopeKey'
import { createProjectionChatBodyReducer } from './projectionChatBodyReducer'

/** Routes only scopes with a matching output codec; unsupported scopes fail before valid publication. */
export function createProjectionScopeHistoryReducer(): ProjectionHistoryReducerPort {
  const chatBody = createProjectionChatBodyReducer()
  const reducerFor = (scopeKey?: string): ProjectionHistoryReducerPort => {
    if (scopeKey && projectionScopeKind(scopeKey) === 'chatBodyV1') return chatBody
    throw new Error('PROJECTION_SPEC_UNSUPPORTED')
  }
  return Object.freeze({
    createState: (scopeKey) => reducerFor(scopeKey).createState(scopeKey),
    fold: (stateJson: string, events: readonly ProjectionHistoryChunkEvent[], facts?: readonly ProjectionMessageFact[], scopeKey?: string) =>
      reducerFor(scopeKey).fold(stateJson, events, facts, scopeKey),
    finalize: (stateJson: string, scopeKey?: string) => reducerFor(scopeKey).finalize(stateJson, scopeKey),
  })
}
