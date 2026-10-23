import { createContextRegistrar, createSessionContextAdapter, type ContextFrame, type SessionContextAdapter } from '../../packages/agent-sdk/src/context'
import type { Message, Session } from '../../src/shared/domainTypes'
import type { SessionQueries } from './public/ports'
import { projectReplaySurfaceWithSources, surfaceItemIdentitiesForProjectionSubset, applyCommittedSurfaceShadow, computeReplaySurfaceFingerprint } from '../../src/shared/surfaceReplay'
import { currentCompactionWindowId, type CompactionReplay } from '../../src/shared/compactionEvents'
import { buildToolChatMessagesFromSource } from '../chatMessageBuild'
import { appendCompactionTransaction, type SessionEventSink } from '../sessionEvents'
import type { SessionContextSurfaceMessage } from '../sessionContextCompaction'
import type { SessionCommitEvent, SessionHistoryPort } from './public/ports'
import { readApiBaselineAfterPreparation } from './public/readMessages'

/** Internal factory-owned signer for a session scope. Only the returned ContextPort belongs to consumers. */
export async function createStorageSessionContextAdapter(input: Readonly<{
  sessionId: string
  session: Pick<Session, 'id' | 'createdAt'>
  queries: Pick<SessionQueries, 'readApiBaseline' | 'readPreparedApiBaseline'>
  ensureChatBodyV1?: (input: Readonly<{ sessionId: string }>) => Promise<unknown>
  workDir: string
  userDataDir: string
  replay: CompactionReplay
  sink: SessionEventSink
  commitCanonicalCompaction(input: { operationId: string; compactionId: string; output: ContextFrame; historyPayload: Record<string, unknown> }): Promise<void>
  isBusy(): boolean
}>): Promise<Readonly<{ adapter: SessionContextAdapter; messages: SessionContextSurfaceMessage[]; windowId: string }>> {
  const registrar = createContextRegistrar()
  const windowId = currentCompactionWindowId(input.replay, `session:${input.sessionId}`)
  const readSourceMessages = async () => (await readApiBaselineAfterPreparation({
    ensureChatBodyV1: input.ensureChatBodyV1, queries: input.queries
  }, { sessionId: input.sessionId, limit: 500 })).entries.map((entry) => entry.message)
  const makeSurface = async (sourceMessages: readonly Message[]) => {
    const latestUser = [...sourceMessages].reverse().find((message) => message.role === 'user')
    if (!latestUser) return []
    const built = await buildToolChatMessagesFromSource({ userDataDir: input.userDataDir, workDir: input.workDir, sourceMessages: [...sourceMessages], currentUserMessageId: latestUser.id, sessionId: input.sessionId })
    const projection = projectReplaySurfaceWithSources(built)
    const identities = surfaceItemIdentitiesForProjectionSubset(projection, projection)
    const surface = projection.messages.map((message, index) => ({ ...message, id: message.id ?? identities[index]! }))
    return applyCommittedSurfaceShadow(surface, input.replay, [latestUser.id], windowId, (items) => computeReplaySurfaceFingerprint('', items))
  }
  const capture = async () => {
    const surface = await makeSurface(await readSourceMessages())
    const projection = projectReplaySurfaceWithSources(surface)
    const identities = surfaceItemIdentitiesForProjectionSubset(projection, projection)
    const checkpointIdentities = new Map<string, string>()
    for (const record of input.replay.committed) {
      const candidate = record.summary.payload.candidate
      if (!candidate || typeof candidate !== 'object') continue
      const checkpointMessage = (candidate as { checkpointMessage?: unknown }).checkpointMessage
      const checkpointId = checkpointMessage && typeof checkpointMessage === 'object' ? (checkpointMessage as { id?: unknown }).id : undefined
      const replayIdentity = (candidate as { checkpointReplayIdentity?: unknown }).checkpointReplayIdentity
      if (typeof checkpointId === 'string' && typeof replayIdentity === 'string') checkpointIdentities.set(checkpointId, replayIdentity)
    }
    const frame: ContextFrame = {
      items: projection.messages.map((message, index) => ({
        replayIdentity: typeof message.id === 'string' ? checkpointIdentities.get(message.id) ?? identities[index]! : identities[index]!,
        sourceMessageIds: typeof message.id === 'string' && checkpointIdentities.has(message.id)
          ? []
          : projection.sourceGroups[index]!.flatMap((source) => typeof source.id === 'string' ? [source.id] : []),
        message: message as import('../../packages/agent-sdk/src/model').CanonicalModelMessage,
        sourceData: {}
      })),
      system: '', windowId, pendingTools: []
    }
    return { frame, surfaceFingerprint: computeReplaySurfaceFingerprint('', projection.messages) }
  }
  const latestFingerprint = async () => computeReplaySurfaceFingerprint('', await makeSurface(await readSourceMessages()))
  const adapter = createSessionContextAdapter({
    scope: { kind: 'session', sessionId: input.sessionId }, registrar,
    capture,
    persist: async ({ operationId, expectedSurfaceFingerprint, outputFingerprint, output, historyPayload }) => {
      if (input.isBusy()) return { status: 'busy' as const }
      if (await latestFingerprint() !== expectedSurfaceFingerprint) return { status: 'stale' as const }
      const transaction = historyPayload as { start?: Record<string, unknown>; summary?: Record<string, unknown> }
      if (!transaction.start || !transaction.summary) throw new Error('SESSION_CONTEXT_TRANSACTION_REQUIRED')
      await input.commitCanonicalCompaction({ operationId, compactionId: String(transaction.start.compactionId ?? operationId), output, historyPayload: historyPayload as Record<string, unknown> })
      await appendCompactionTransaction(input.sink, transaction.start, transaction.summary)
      return { status: 'committed' as const }
    }
  })
  return { adapter, messages: await makeSurface(await readSourceMessages()) as SessionContextSurfaceMessage[], windowId }
}
