import { parentPort, threadId } from 'node:worker_threads'
import { getHeapStatistics } from 'node:v8'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import type { ProjectionPendingHistoryChunkManifestRef } from '../../domain/projectionBuild'
import type { ProjectionReducerArtifactStaging } from '../../application/projectionBuildCoordinator'
import { createProjectionScopeHistoryReducer } from './projectionScopeHistoryReducer'

if (!parentPort) throw new Error('projection history reducer worker requires a parent port')

parentPort.once('message', (message: {
  requestId: string
  stateJson: string
  events: readonly ProjectionHistoryChunkEvent[]
  messageFacts: readonly ProjectionMessageFact[]
  scopeKey: string
  finalize: boolean
  stagedChunk?: Readonly<{ root: string; manifest: ProjectionPendingHistoryChunkManifestRef }>
  staging?: ProjectionReducerArtifactStaging
}) => {
  void (async () => {
    const startedAt = performance.now()
    const reducer = createProjectionScopeHistoryReducer()
    let stateJson = message.stateJson
    const priorReducerState = message.staging?.context.priorReducerState
    if (priorReducerState) {
      if (priorReducerState.sessionId !== message.staging!.context.sessionId ||
        priorReducerState.scopeKey !== message.scopeKey ||
        priorReducerState.sourceIdentityJson !== message.staging!.context.sourceIdentityJson ||
        !/^projection-[0-9a-f-]{36}\.blob$/.test(priorReducerState.locator) ||
        path.basename(priorReducerState.locator) !== priorReducerState.locator) {
        throw new Error('PROJECTION_REDUCER_STATE_REFERENCE_INVALID')
      }
      let bytes: Buffer
      try { bytes = await fs.readFile(path.join(path.resolve(message.staging!.root), priorReducerState.locator)) }
      catch { throw new Error('PROJECTION_REDUCER_STATE_UNAVAILABLE') }
      if (bytes.byteLength !== priorReducerState.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== priorReducerState.payloadDigest) {
        throw new Error('PROJECTION_REDUCER_STATE_DIGEST_MISMATCH')
      }
      stateJson = bytes.toString('utf8')
      try { JSON.parse(stateJson) } catch { throw new Error('PROJECTION_REDUCER_STATE_INVALID_JSON') }
    }
    let events = message.events
    let messageFacts = message.messageFacts
    if (message.stagedChunk) {
      const { root, manifest } = message.stagedChunk
      if (manifest.scopeKey !== message.scopeKey || !/^projection-[0-9a-f-]{36}\.blob$/.test(manifest.locator) ||
        path.basename(manifest.locator) !== manifest.locator) throw new Error('PROJECTION_PENDING_CHUNK_REFERENCE_INVALID')
      let bytes: Buffer
      try { bytes = await fs.readFile(path.join(path.resolve(root), manifest.locator)) }
      catch { throw new Error('PROJECTION_PENDING_CHUNK_UNAVAILABLE') }
      if (bytes.byteLength !== manifest.byteLength || createHash('sha256').update(bytes).digest('hex') !== manifest.payloadDigest) {
        throw new Error('PROJECTION_PENDING_CHUNK_DIGEST_MISMATCH')
      }
      let payload: { events?: unknown; messageFacts?: unknown }
      try { payload = JSON.parse(bytes.toString('utf8')) as typeof payload }
      catch { throw new Error('PROJECTION_PENDING_CHUNK_INVALID_JSON') }
      if (!Array.isArray(payload.events) || !Array.isArray(payload.messageFacts) || payload.events.length !== manifest.rowCount ||
        payload.events.some((event, index) => !event || typeof event !== 'object' ||
          (event as ProjectionHistoryChunkEvent).sessionSequence !== manifest.fromSequence + index + 1) ||
        (payload.events.at(-1) as ProjectionHistoryChunkEvent | undefined)?.sessionSequence !== manifest.nextSequence) {
        throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
      }
      events = payload.events as ProjectionHistoryChunkEvent[]
      messageFacts = payload.messageFacts as ProjectionMessageFact[]
    }
    const folded = reducer.fold(stateJson, events, messageFacts, message.scopeKey)
    const finalizedOutputOperations = message.finalize
      ? reducer.finalize(folded.stateJson, message.scopeKey).outputOperations
      : undefined
    let result: Record<string, unknown> = { ...folded,
      ...(finalizedOutputOperations ? { finalizedOutputOperations } : {}), workerThreadId: threadId,
      workerSample: { durationMs: Math.max(0, performance.now() - startedAt),
        heapUsedBytesAtExit: getHeapStatistics().used_heap_size, processRssBytesAtExit: process.memoryUsage.rss() } }
    if (message.staging) {
      const { root, context } = message.staging
      const writeArtifact = async (locator: string, payload: string) => {
        if (!/^\.projection-[0-9a-f-]{36}\.tmp$/.test(locator) || path.basename(locator) !== locator) {
          throw new Error('PROJECTION_REDUCER_ARTIFACT_LOCATOR_INVALID')
        }
        const bytes = Buffer.from(payload, 'utf8')
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined
        try {
          handle = await fs.open(path.join(path.resolve(root), locator), 'wx', 0o600)
          await handle.writeFile(bytes)
          await handle.sync()
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code && ['EACCES', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'EROFS'].includes(code)) {
            throw new Error(`PROJECTION_REDUCER_WORKER_ARTIFACT_IO:${code}`)
          }
          throw error
        } finally { await handle?.close() }
        return { tempLocator: locator, byteLength: bytes.byteLength, payloadDigest: createHash('sha256').update(bytes).digest('hex') }
      }
      const outputOperations = [...folded.outputOperations, ...(finalizedOutputOperations ?? [])]
      const outputPayload = JSON.stringify({ formatVersion: 2, sessionId: context.sessionId,
        sessionGeneration: context.sessionGeneration, scopeKey: context.scopeKey, specVersion: context.specVersion,
        sourceIdentityJson: context.sourceIdentityJson,
        outputManifest: { formatVersion: 1, parent: folded.resetOutput ? null : context.parentOutputManifest,
          operations: outputOperations }, sourceComplete: message.finalize })
      const stableIndex = await buildStableIdIndex({ root, prior: context.priorStableIdIndex, operations: outputOperations,
        identity: { sessionId: context.sessionId, scopeKey: context.scopeKey, sourceIdentityJson: context.sourceIdentityJson } })
      const [outputManifest, stableIdIndex, reducerState] = await Promise.all([
        writeArtifact(message.staging.outputManifestTempLocator, outputPayload),
        writeArtifact(message.staging.stableIdIndexTempLocator, stableIndex.payload),
        Buffer.byteLength(folded.stateJson) > 64 * 1024
          ? writeArtifact(message.staging.reducerStateTempLocator, folded.stateJson) : Promise.resolve(undefined),
      ])
      result = { resetOutput: folded.resetOutput,
        ...(reducerState ? {} : { stateJson: folded.stateJson }),
        stagedArtifacts: { outputManifest, stableIdIndex: { ...stableIdIndex, itemCount: stableIndex.itemCount },
          ...(reducerState ? { reducerState } : {}) }, workerThreadId: threadId,
        workerSample: { durationMs: Math.max(0, performance.now() - startedAt),
          heapUsedBytesAtExit: getHeapStatistics().used_heap_size, processRssBytesAtExit: process.memoryUsage.rss() } }
    }
    parentPort!.postMessage({ requestId: message.requestId, result })
    parentPort!.close()
  })().catch((error) => {
    parentPort!.postMessage({ requestId: message.requestId, error: error instanceof Error ? error.message : 'PROJECTION_REDUCER_FAILED' })
    parentPort!.close()
  })
})

async function buildStableIdIndex(input: Readonly<{
  root: string
  prior: ProjectionReducerArtifactStaging['context']['priorStableIdIndex']
  operations: readonly unknown[]
  identity: Readonly<{ sessionId: string; scopeKey: string; sourceIdentityJson: string }>
}>): Promise<Readonly<{ payload: string; itemCount: number }>> {
  let entries: Array<{ id: string; role: string }> = []
  if (input.prior) {
    const ref = input.prior
    if (!/^projection-[0-9a-f-]{36}\.blob$/.test(ref.locator) || path.basename(ref.locator) !== ref.locator) {
      throw new Error('PROJECTION_STABLE_ID_INDEX_INVALID')
    }
    let bytes: Buffer
    try { bytes = await fs.readFile(path.join(path.resolve(input.root), ref.locator)) }
    catch { throw new Error('PROJECTION_STABLE_ID_INDEX_INVALID') }
    if (bytes.byteLength !== ref.byteLength || createHash('sha256').update(bytes).digest('hex') !== ref.payloadDigest) {
      throw new Error('PROJECTION_STABLE_ID_INDEX_INVALID')
    }
    let prior: { formatVersion?: unknown; messageCount?: unknown; sessionId?: unknown;
      scopeKey?: unknown; sourceIdentityJson?: unknown; ids?: unknown; entries?: unknown }
    try { prior = JSON.parse(bytes.toString('utf8')) as typeof prior }
    catch { throw new Error('PROJECTION_STABLE_ID_INDEX_INVALID') }
    const ids = Array.isArray(prior.ids) ? prior.ids : []
    const priorEntries = Array.isArray(prior.entries) ? prior.entries : []
    if (prior.formatVersion !== 1 || prior.messageCount !== ref.itemCount || prior.sessionId !== input.identity.sessionId ||
      prior.scopeKey !== input.identity.scopeKey || prior.sourceIdentityJson !== input.identity.sourceIdentityJson ||
      priorEntries.length !== ref.itemCount || ids.length !== priorEntries.length || new Set(ids).size !== ids.length ||
      priorEntries.some((entry, ordinal) => !entry || typeof entry !== 'object' ||
        (entry as { id?: unknown }).id !== ids[ordinal] || typeof (entry as { role?: unknown }).role !== 'string' ||
        !(entry as { role: string }).role.trim() || (entry as { ordinal?: unknown }).ordinal !== ordinal)) {
      throw new Error('PROJECTION_STABLE_ID_INDEX_INVALID')
    }
    entries = priorEntries.map((entry) => ({ id: (entry as { id: string }).id, role: (entry as { role: string }).role }))
  }
  for (const raw of input.operations) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PROJECTION_STABLE_ID_OUTPUT_OPERATION_INVALID')
    const operation = raw as { type?: unknown; messages?: unknown; updates?: unknown }
    if (operation.type === 'appendText') {
      if (!Array.isArray(operation.updates)) throw new Error('PROJECTION_STABLE_ID_OUTPUT_OPERATION_INVALID')
      for (const rawUpdate of operation.updates) {
        if (!rawUpdate || typeof rawUpdate !== 'object' || Array.isArray(rawUpdate)) throw new Error('PROJECTION_STABLE_ID_OUTPUT_OPERATION_INVALID')
        const update = rawUpdate as { id?: unknown; role?: unknown; text?: unknown }
        const existing = entries.find((entry) => entry.id === update.id)
        if (typeof update.id !== 'string' || !update.id.trim() || update.role !== 'assistant' || typeof update.text !== 'string' ||
          !existing || existing.role !== update.role) throw new Error('PROJECTION_STABLE_ID_TEXT_APPEND_TARGET_INVALID')
      }
      continue
    }
    if ((operation.type !== 'append' && operation.type !== 'replace') || !Array.isArray(operation.messages)) {
      throw new Error('PROJECTION_STABLE_ID_OUTPUT_OPERATION_INVALID')
    }
    if (operation.type === 'replace') entries = []
    for (const message of operation.messages) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('PROJECTION_STABLE_ID_OUTPUT_MESSAGE_INVALID')
      const candidate = message as { id?: unknown; role?: unknown }
      if (candidate.id === undefined || candidate.id === null) continue
      if (typeof candidate.id !== 'string' || !candidate.id.trim() || typeof candidate.role !== 'string' || !candidate.role.trim()) {
        throw new Error('PROJECTION_STABLE_ID_OUTPUT_IDENTITY_INVALID')
      }
      const existing = entries.find((entry) => entry.id === candidate.id)
      if (existing && existing.role !== candidate.role) throw new Error('PROJECTION_STABLE_ID_ROLE_CHANGED')
      if (!existing) entries.push({ id: candidate.id, role: candidate.role })
    }
  }
  const payload = JSON.stringify({ formatVersion: 1, messageCount: entries.length, ...input.identity,
    ids: entries.map((entry) => entry.id), entries: entries.map((entry, ordinal) => ({ ...entry, ordinal })) })
  return { payload, itemCount: entries.length }
}
