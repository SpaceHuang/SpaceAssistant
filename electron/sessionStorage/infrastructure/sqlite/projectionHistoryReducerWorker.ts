import { parentPort, threadId } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import type { ProjectionPendingHistoryChunkManifestRef } from '../../domain/projectionBuild'
import type { ProjectionReducerArtifactStaging } from '../../application/projectionBuildCoordinator'
import { createProjectionScopeHistoryReducer } from './projectionScopeHistoryReducer'
import { createProjectionWorkerMemorySampler } from './projectionWorkerMemorySampler'
import { projectionScopeKind } from '../../domain/scopeKey'
import { readProjectionHistorySegmentItems } from './projectionHistorySegmentReader'
import { reduceSegmentedChatBodyContext } from './projectionSegmentedChatBodyReducer'

if (!parentPort) throw new Error('projection history reducer worker requires a parent port')
const memorySampler = createProjectionWorkerMemorySampler()
const MAX_OUTPUT_MANIFEST_SEGMENT_BYTES = 16 * 1024 * 1024

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
    const writeArtifact = async (root: string, locator: string, payload: string) => {
      async function* payloadChunks() { yield payload }
      return writeArtifactChunks(root, locator, payloadChunks())
    }
    const writeArtifactChunks = async (root: string, locator: string, chunks: AsyncIterable<string | Buffer>) => {
      if (!/^\.projection-[0-9a-f-]{36}\.tmp$/.test(locator) || path.basename(locator) !== locator) {
        throw new Error('PROJECTION_REDUCER_ARTIFACT_LOCATOR_INVALID')
      }
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined
      const hash = createHash('sha256')
      let byteLength = 0
      try {
        handle = await fs.open(path.join(path.resolve(root), locator), 'wx', 0o600)
        for await (const chunk of chunks) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
          let offset = 0
          while (offset < bytes.byteLength) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null)
            if (bytesWritten < 1) throw new Error('PROJECTION_REDUCER_ARTIFACT_WRITE_INCOMPLETE')
            offset += bytesWritten
          }
          hash.update(bytes)
          byteLength += bytes.byteLength
        }
        await handle.sync()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code && ['EACCES', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'EROFS'].includes(code)) {
          throw new Error(`PROJECTION_REDUCER_WORKER_ARTIFACT_IO:${code}`)
        }
        throw error
      } finally { await handle?.close() }
      return { tempLocator: locator, locator: `${locator.slice(1, -4)}.blob`, byteLength,
        payloadDigest: hash.digest('hex') }
    }
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
    let result: Record<string, unknown>
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
      if (payload && typeof payload === 'object' && (payload as { kind?: unknown }).kind === 'segmented-history-event') {
        const segmented = payload as { formatVersion?: unknown; event?: unknown; messageCount?: unknown;
          messageSegments?: unknown; factCount?: unknown; factSegments?: unknown; extraPayload?: unknown; requiredUserMessage?: unknown;
          requiredUserSegments?: unknown; requiredUserMessageRef?: unknown }
        if ((segmented.formatVersion !== 2 && segmented.formatVersion !== 3) || !segmented.event || typeof segmented.event !== 'object' || Array.isArray(segmented.event) ||
          !Number.isSafeInteger(segmented.messageCount) || (segmented.messageCount as number) < 1 ||
          !Array.isArray(segmented.messageSegments) || segmented.messageSegments.length < 1 || segmented.messageSegments.length > 15 ||
          !Number.isSafeInteger(segmented.factCount) || (segmented.factCount as number) < 0 ||
          !Array.isArray(segmented.factSegments) || segmented.factSegments.length > 15 ||
          (segmented.requiredUserSegments !== undefined && (!Array.isArray(segmented.requiredUserSegments) ||
            (segmented.requiredUserSegments as unknown[]).length < 2)) ||
          (segmented.requiredUserMessageRef !== undefined && (segmented.formatVersion !== 3 || !segmented.requiredUserMessageRef ||
            typeof segmented.requiredUserMessageRef !== 'object' || Array.isArray(segmented.requiredUserMessageRef))) ||
          (segmented.requiredUserMessageRef !== undefined && (segmented.requiredUserMessage !== undefined ||
            segmented.requiredUserSegments !== undefined)) ||
          segmented.messageSegments.length + segmented.factSegments.length +
            (Array.isArray(segmented.requiredUserSegments) ? segmented.requiredUserSegments.length : 0) > 15) {
          throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
        }
        const event = segmented.event as Partial<ProjectionHistoryChunkEvent>
        if (typeof event.invocationId !== 'string' || !event.invocationId || typeof event.turnId !== 'string' || !event.turnId ||
          !Number.isSafeInteger(event.sequence) || (event.sequence ?? 0) < 1 || typeof event.eventId !== 'string' || !event.eventId ||
          typeof event.idempotencyKey !== 'string' || !event.idempotencyKey || !Number.isSafeInteger(event.schemaVersion) ||
          (event.schemaVersion ?? 0) < 1 || (event.kind !== 'invocation-context-committed' && event.kind !== 'transcript-compacted') ||
          event.sessionSequence !== manifest.nextSequence || !Number.isSafeInteger(event.commitOrder) || (event.commitOrder ?? 0) < 1 ||
          !Number.isSafeInteger(event.createdAt)) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
        const messages: unknown[] = []
        const factsFromSegments: ProjectionMessageFact[] = []
        const segmentLocators = new Set<string>()
        let segmentByteLength = 0
        const readSegmentBytes = async (rawSegment: unknown): Promise<Readonly<{ bytes: Buffer; descriptor: {
          locator: string; byteLength: number; payloadDigest: string; itemCount: number; encoding?: unknown;
          firstItemIndex?: unknown; fragmentIndex?: unknown; fragmentCount?: unknown
        } }>> => {
          if (!rawSegment || typeof rawSegment !== 'object' || Array.isArray(rawSegment)) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
          const descriptor = rawSegment as { locator?: unknown; byteLength?: unknown; payloadDigest?: unknown; itemCount?: unknown;
            encoding?: unknown; firstItemIndex?: unknown; fragmentIndex?: unknown; fragmentCount?: unknown }
          if (typeof descriptor.locator !== 'string' || !/^projection-[0-9a-f-]{36}\.blob$/.test(descriptor.locator) ||
            path.basename(descriptor.locator) !== descriptor.locator || !Number.isSafeInteger(descriptor.byteLength) ||
            (descriptor.byteLength as number) < 1 || (descriptor.byteLength as number) > 16 * 1024 * 1024 ||
            typeof descriptor.payloadDigest !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.payloadDigest) ||
            !Number.isSafeInteger(descriptor.itemCount) || (descriptor.itemCount as number) < 0 ||
            (descriptor.encoding !== undefined && descriptor.encoding !== 'json-item-fragment') || segmentLocators.has(descriptor.locator)) {
            throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
          }
          segmentLocators.add(descriptor.locator)
          let bytes: Buffer
          try { bytes = await fs.readFile(path.join(path.resolve(root), descriptor.locator)) }
          catch { throw new Error('PROJECTION_PENDING_CHUNK_UNAVAILABLE') }
          if (bytes.byteLength !== descriptor.byteLength || createHash('sha256').update(bytes).digest('hex') !== descriptor.payloadDigest) {
            throw new Error('PROJECTION_PENDING_CHUNK_DIGEST_MISMATCH')
          }
          segmentByteLength += bytes.byteLength
          if (segmentByteLength > 128 * 1024 * 1024) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
          return { bytes, descriptor: descriptor as typeof descriptor & { locator: string; byteLength: number;
            payloadDigest: string; itemCount: number } }
        }
        const readSegments = async (rawSegments: unknown[], items: unknown[]) => {
          let index = 0
          while (index < rawSegments.length) {
            const { bytes, descriptor } = await readSegmentBytes(rawSegments[index])
            if (descriptor.encoding !== 'json-item-fragment') {
              if (descriptor.itemCount < 1 || (descriptor.firstItemIndex !== undefined && descriptor.firstItemIndex !== items.length)) {
                throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
              }
              let payload: unknown
              try { payload = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('PROJECTION_PENDING_CHUNK_INVALID_JSON') }
              if (!Array.isArray(payload) || payload.length !== descriptor.itemCount) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
              for (const item of payload) items.push(item)
              index += 1
              continue
            }
            const itemIndex = descriptor.firstItemIndex
            const fragmentCount = descriptor.fragmentCount
            if (itemIndex !== items.length || descriptor.fragmentIndex !== 0 || descriptor.itemCount !== 1 ||
              !Number.isSafeInteger(fragmentCount) || (fragmentCount as number) < 2 || (fragmentCount as number) > 15 ||
              index + (fragmentCount as number) > rawSegments.length) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
            const fragments = [bytes]
            for (let fragmentIndex = 1; fragmentIndex < (fragmentCount as number); fragmentIndex += 1) {
              const next = await readSegmentBytes(rawSegments[index + fragmentIndex])
              if (next.descriptor.encoding !== 'json-item-fragment' || next.descriptor.firstItemIndex !== itemIndex ||
                next.descriptor.fragmentIndex !== fragmentIndex || next.descriptor.fragmentCount !== fragmentCount ||
                next.descriptor.itemCount !== 0) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
              fragments.push(next.bytes)
            }
            let item: unknown
            try { item = JSON.parse(Buffer.concat(fragments).toString('utf8')) }
            catch { throw new Error('PROJECTION_PENDING_CHUNK_INVALID_JSON') }
            items.push(item)
            index += fragmentCount as number
          }
        }
        if (message.staging && projectionScopeKind(message.scopeKey) === 'chatBodyV1' &&
          (event.kind === 'invocation-context-committed' || event.kind === 'transcript-compacted')) {
          const messageSegments = segmented.messageSegments as Parameters<typeof readProjectionHistorySegmentItems<unknown>>[0]['segments']
          const factSegments = segmented.factSegments as Parameters<typeof readProjectionHistorySegmentItems<unknown>>[0]['segments']
          const factsFromSegments: ProjectionMessageFact[] = []
          for await (const fact of readProjectionHistorySegmentItems<unknown>({ segments: factSegments,
            itemCount: segmented.factCount as number, readVerified: async (descriptor) =>
              (await readSegmentBytes(descriptor)).bytes })) {
            if (!isProjectionMessageFact(fact)) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
            factsFromSegments.push(fact)
          }
          let requiredUserMessage = segmented.requiredUserMessage as { id?: unknown; message?: unknown } | undefined
          if (segmented.requiredUserMessageRef !== undefined) {
            const reference = segmented.requiredUserMessageRef as { id?: unknown; messageIndex?: unknown }
            if (typeof reference.id !== 'string' || !reference.id.trim() || !Number.isSafeInteger(reference.messageIndex) ||
              (reference.messageIndex as number) < 0 || (reference.messageIndex as number) >= (segmented.messageCount as number)) {
              throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
            }
          }
          if (segmented.requiredUserSegments !== undefined) {
            const requiredItems: unknown[] = []
            for await (const item of readProjectionHistorySegmentItems<unknown>({
              segments: segmented.requiredUserSegments as Parameters<typeof readProjectionHistorySegmentItems<unknown>>[0]['segments'],
              itemCount: 1, readVerified: async (descriptor) => (await readSegmentBytes(descriptor)).bytes })) requiredItems.push(item)
            if (requiredItems.length !== 1 || requiredUserMessage !== undefined) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
            requiredUserMessage = requiredItems[0] as typeof requiredUserMessage
          }
          if (factsFromSegments.length !== segmented.factCount || segmentByteLength > 128 * 1024 * 1024) {
            throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
          }
          if (segmented.extraPayload !== undefined && (!segmented.extraPayload || typeof segmented.extraPayload !== 'object' ||
            Array.isArray(segmented.extraPayload))) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')

          const entries: Array<{ id: string; role: string }> = []
          const seenIds = new Set<string>()
          const rootPath = path.resolve(message.staging.root)
          const requiredUserMessageShape = requiredUserMessage && typeof requiredUserMessage.id === 'string' &&
            requiredUserMessage.message && typeof requiredUserMessage.message === 'object' && !Array.isArray(requiredUserMessage.message)
            ? { id: requiredUserMessage.id, message: requiredUserMessage.message as import('../../../../packages/agent-sdk/src/model').CanonicalModelMessage }
            : undefined
          if (requiredUserMessage && !requiredUserMessageShape) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
          const outputManifests: Array<Awaited<ReturnType<typeof writeArtifact>>> = []
          let currentOperations: unknown[] = []
          let currentBytes = 0
          const emitProjected = async (projected: Readonly<{ id: string; role: string; content: unknown; timestamp: number }>) => {
            const operation = { type: entries.length === 1 ? 'replace' : 'append', messages: [projected] }
            const opBytes = Buffer.byteLength(JSON.stringify(operation))
            if (currentOperations.length && currentBytes + opBytes > MAX_OUTPUT_MANIFEST_SEGMENT_BYTES) await flushManifest(false)
            currentOperations.push(operation)
            currentBytes += opBytes
          }
          const flushManifest = async (sourceComplete: boolean) => {
            if (!currentOperations.length && outputManifests.length) return
            const locator = message.staging!.outputManifestTempLocators[outputManifests.length]
            if (!locator) throw new Error('PROJECTION_REDUCER_OUTPUT_SEGMENT_LIMIT_EXCEEDED')
            const previous = outputManifests.at(-1)
            const envelope = JSON.stringify({ formatVersion: 2, sessionId: message.staging!.context.sessionId,
              sessionGeneration: message.staging!.context.sessionGeneration, scopeKey: message.staging!.context.scopeKey,
              specVersion: message.staging!.context.specVersion, sourceIdentityJson: message.staging!.context.sourceIdentityJson,
              outputManifest: { formatVersion: 1, parent: previous ? { locator: previous.locator, byteLength: previous.byteLength,
                payloadDigest: previous.payloadDigest } : null, operations: [] }, sourceComplete })
            const marker = '"operations":[]'
            const markerIndex = envelope.indexOf(marker)
            if (markerIndex < 0) throw new Error('PROJECTION_REDUCER_OUTPUT_MANIFEST_INVALID')
            const prefix = Buffer.from(`${envelope.slice(0, markerIndex)}"operations":[`, 'utf8')
            const suffix = Buffer.from(`]${envelope.slice(markerIndex + marker.length)}`, 'utf8')
            async function* manifestChunks(): AsyncGenerator<Buffer> {
              yield prefix
              for (const [index, operation] of currentOperations.entries()) {
                if (index > 0) yield Buffer.from(',')
                yield Buffer.from(JSON.stringify(operation), 'utf8')
              }
              yield suffix
            }
            const artifact = await writeArtifactChunks(rootPath, locator, manifestChunks())
            outputManifests.push(artifact)
            currentOperations = []
            currentBytes = 0
          }
          const reduction = await reduceSegmentedChatBodyContext({ stateJson, event: { ...event as ProjectionHistoryChunkEvent, payloadJson: '',
            payload: { ...((segmented.extraPayload as Record<string, unknown> | undefined) ?? {}), messages: [] } },
            messages: readProjectionHistorySegmentItems<unknown>({ segments: messageSegments,
              itemCount: segmented.messageCount as number, readVerified: async (descriptor) =>
                (await readSegmentBytes(descriptor)).bytes }),
            messageCount: segmented.messageCount as number, facts: factsFromSegments, scopeKey: message.scopeKey,
            ...(requiredUserMessageShape ? { requiredUserMessage: requiredUserMessageShape } : {}),
            ...(segmented.requiredUserMessageRef ? { requiredUserMessageRef: segmented.requiredUserMessageRef as { id: string; messageIndex: number } } : {}),
            onProjectedMessage: async (projected) => {
              if (seenIds.has(projected.id)) throw new Error('PROJECTION_STABLE_ID_OUTPUT_IDENTITY_INVALID')
              seenIds.add(projected.id)
              entries.push({ id: projected.id, role: projected.role })
              await emitProjected(projected)
            } })
          if (!currentOperations.length && outputManifests.length === 0) currentOperations.push({ type: 'replace', messages: [] })
          await flushManifest(message.finalize)
          const stableIndex = JSON.stringify({ formatVersion: 1, messageCount: entries.length,
            sessionId: message.staging.context.sessionId, scopeKey: message.staging.context.scopeKey,
            sourceIdentityJson: message.staging.context.sourceIdentityJson,
            ids: entries.map((entry) => entry.id), entries: entries.map((entry, ordinal) => ({ ...entry, ordinal })) })
          const stableArtifact = await writeArtifact(rootPath, message.staging.stableIdIndexTempLocator, stableIndex)
          const reducerState = Buffer.byteLength(reduction.stateJson) > 64 * 1024
            ? await writeArtifact(rootPath, message.staging.reducerStateTempLocator, reduction.stateJson) : undefined
          result = { resetOutput: true, ...(!reducerState ? { stateJson: reduction.stateJson } : {}),
            stagedArtifacts: { outputManifests, stableIdIndex: { ...stableArtifact, itemCount: entries.length },
              ...(reducerState ? { reducerState } : {}) }, workerThreadId: threadId }
          result.workerSample = { durationMs: Math.max(0, performance.now() - startedAt), ...memorySampler.finish() }
          parentPort!.postMessage({ requestId: message.requestId, result })
          parentPort!.close()
          return
        }
        await readSegments(segmented.messageSegments as unknown[], messages)
        await readSegments(segmented.factSegments as unknown[], factsFromSegments as unknown[])
        let requiredUserMessage = segmented.requiredUserMessage
        if (segmented.requiredUserMessageRef !== undefined) {
          const reference = segmented.requiredUserMessageRef as { id?: unknown; messageIndex?: unknown }
          if (typeof reference.id !== 'string' || !reference.id.trim() || !Number.isSafeInteger(reference.messageIndex) ||
            (reference.messageIndex as number) < 0 || (reference.messageIndex as number) >= messages.length) {
            throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
          }
          const referencedMessage = messages[reference.messageIndex as number] as { id?: unknown } | undefined
          if (!referencedMessage || typeof referencedMessage !== 'object' || Array.isArray(referencedMessage) ||
            referencedMessage.id !== reference.id) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
          requiredUserMessage = { id: reference.id, message: referencedMessage }
        }
        if (segmented.requiredUserSegments !== undefined) {
          if (requiredUserMessage !== undefined || (segmented.requiredUserSegments as unknown[])
            .some((segment) => !segment || typeof segment !== 'object' || (segment as { encoding?: unknown }).encoding !== 'json-item-fragment')) {
            throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
          }
          const requiredUserItems: unknown[] = []
          await readSegments(segmented.requiredUserSegments as unknown[], requiredUserItems)
          if (requiredUserItems.length !== 1) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
          requiredUserMessage = requiredUserItems[0]
        }
        if (messages.length !== segmented.messageCount || segmentByteLength > 128 * 1024 * 1024) {
          throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
        }
        if (segmented.extraPayload !== undefined && (!segmented.extraPayload || typeof segmented.extraPayload !== 'object' ||
          Array.isArray(segmented.extraPayload))) {
          throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
        }
        if (factsFromSegments.length !== segmented.factCount || factsFromSegments.some((fact) => !isProjectionMessageFact(fact))) {
          throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
        }
        const extraPayload = segmented.extraPayload as Record<string, unknown> | undefined
        const eventPayload = { ...(extraPayload ?? {}), messages,
          ...(requiredUserMessage === undefined ? {} : { requiredUserMessage }) }
        events = [{ ...event, payloadJson: '', payload: eventPayload } as ProjectionHistoryChunkEvent]
        messageFacts = factsFromSegments
      } else {
      if (!Array.isArray(payload.events) || !Array.isArray(payload.messageFacts) || payload.events.length !== manifest.rowCount ||
        payload.events.some((event, index) => !event || typeof event !== 'object' ||
          (event as ProjectionHistoryChunkEvent).sessionSequence !== manifest.fromSequence + index + 1) ||
        (payload.events.at(-1) as ProjectionHistoryChunkEvent | undefined)?.sessionSequence !== manifest.nextSequence) {
        throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
      }
      events = payload.events as ProjectionHistoryChunkEvent[]
      messageFacts = payload.messageFacts as ProjectionMessageFact[]
      }
    }
    const folded = reducer.fold(stateJson, events, messageFacts, message.scopeKey)
    const finalizedOutputOperations = message.finalize
      ? reducer.finalize(folded.stateJson, message.scopeKey).outputOperations
      : undefined
    result = { ...folded,
      ...(finalizedOutputOperations ? { finalizedOutputOperations } : {}), workerThreadId: threadId }
    if (message.staging) {
      const { root, context } = message.staging
      const outputOperations = [...folded.outputOperations, ...(finalizedOutputOperations ?? [])]
      const operationSegments = segmentOutputOperations(outputOperations)
      if (operationSegments.length > message.staging.outputManifestTempLocators.length) {
        throw new Error('PROJECTION_REDUCER_OUTPUT_SEGMENT_LIMIT_EXCEEDED')
      }
      const stableIndex = await buildStableIdIndex({ root, prior: context.priorStableIdIndex, operations: outputOperations,
        identity: { sessionId: context.sessionId, scopeKey: context.scopeKey, sourceIdentityJson: context.sourceIdentityJson } })
      const outputManifests: Array<Awaited<ReturnType<typeof writeArtifact>>> = []
      let parent = folded.resetOutput ? null : context.parentOutputManifest
      for (const [index, operations] of operationSegments.entries()) {
        const outputPayload = JSON.stringify({ formatVersion: 2, sessionId: context.sessionId,
          sessionGeneration: context.sessionGeneration, scopeKey: context.scopeKey, specVersion: context.specVersion,
          sourceIdentityJson: context.sourceIdentityJson,
          outputManifest: { formatVersion: 1, parent, operations }, sourceComplete: message.finalize && index === operationSegments.length - 1 })
        const artifact = await writeArtifact(root, message.staging.outputManifestTempLocators[index]!, outputPayload)
        outputManifests.push(artifact)
        parent = { locator: artifact.locator, byteLength: artifact.byteLength, payloadDigest: artifact.payloadDigest }
      }
      const [stableIdIndex, reducerState] = await Promise.all([
        writeArtifact(root, message.staging.stableIdIndexTempLocator, stableIndex.payload),
        Buffer.byteLength(folded.stateJson) > 64 * 1024
          ? writeArtifact(root, message.staging.reducerStateTempLocator, folded.stateJson) : Promise.resolve(undefined),
      ])
      result = { resetOutput: folded.resetOutput,
        ...(reducerState ? {} : { stateJson: folded.stateJson }),
        stagedArtifacts: { outputManifests, stableIdIndex: { ...stableIdIndex, itemCount: stableIndex.itemCount },
          ...(reducerState ? { reducerState } : {}) }, workerThreadId: threadId }
    }
    result.workerSample = { durationMs: Math.max(0, performance.now() - startedAt), ...memorySampler.finish() }
    parentPort!.postMessage({ requestId: message.requestId, result })
    parentPort!.close()
  })().catch((error) => {
    memorySampler.finish()
    parentPort!.postMessage({ requestId: message.requestId, error: error instanceof Error ? error.message : 'PROJECTION_REDUCER_FAILED' })
    parentPort!.close()
  })
})

function segmentOutputOperations(operations: readonly unknown[]): readonly (readonly unknown[])[] {
  const segments: unknown[][] = []
  let current: unknown[] = []
  let currentBytes = 0
  const flush = () => { if (current.length) { segments.push(current); current = []; currentBytes = 0 } }
  const add = (operation: unknown) => {
    const byteLength = Buffer.byteLength(JSON.stringify(operation) ?? 'null')
    if (current.length && currentBytes + byteLength > MAX_OUTPUT_MANIFEST_SEGMENT_BYTES) flush()
    current.push(operation)
    currentBytes += byteLength
  }
  for (const raw of operations) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { add(raw); continue }
    const operation = raw as { type?: unknown; messages?: unknown; updates?: unknown }
    if ((operation.type === 'append' || operation.type === 'replace') && Array.isArray(operation.messages)) {
      if (operation.messages.length === 0) { add(operation); continue }
      for (const [index, message] of operation.messages.entries()) {
        add({ type: operation.type === 'replace' && index === 0 ? 'replace' : 'append', messages: [message] })
      }
      continue
    }
    if (operation.type === 'appendText' && Array.isArray(operation.updates)) {
      if (operation.updates.length === 0) { add(operation); continue }
      for (const update of operation.updates) add({ type: 'appendText', updates: [update] })
      continue
    }
    add(operation)
  }
  flush()
  return Object.freeze((segments.length ? segments : [[]]).map((segment) => Object.freeze(segment)))
}

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

function isProjectionMessageFact(value: unknown): value is ProjectionMessageFact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fact = value as Partial<ProjectionMessageFact>
  return typeof fact.id === 'string' && Boolean(fact.id) && typeof fact.role === 'string' &&
    Number.isSafeInteger(fact.timestamp) && Number.isSafeInteger(fact.sequence) && typeof fact.queueScope === 'string' &&
    (fact.contentStorageState === 'legacy' || fact.contentStorageState === 'canonical-backed-dual-write' ||
      fact.contentStorageState === 'canonical-backed-only') &&
    (fact.writeMode === null || typeof fact.writeMode === 'string') && typeof fact.storedContent === 'string' &&
    (fact.storedContentLength === undefined || (Number.isSafeInteger(fact.storedContentLength) && fact.storedContentLength >= 0)) &&
    (fact.storedContentDigest === undefined || /^[a-f0-9]{64}$/.test(fact.storedContentDigest)) &&
    (fact.storedContentDigest === undefined || (fact.contentStorageState === 'canonical-backed-dual-write' &&
      fact.storedContent === '' && Number.isSafeInteger(fact.storedContentLength)))
}
