import path from 'node:path'
import { parentPort, threadId } from 'node:worker_threads'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { readSourceTruthSpillSync, type SpillDescriptor } from '../../../storage/spillProtocol'

if (!parentPort) throw new Error('projection source chat body worker requires a parent port')

type Fragment = Readonly<{ id: string; sequence: number; locator: string; byteLength: number; sha256: string }>
type Input = Readonly<{ requestId: string; root: string; sessionId: string; sessionGeneration: string; sourceRevision: number;
  fragments: readonly Fragment[]; sourceSpillRoot?: string; sourceTruthSpills: readonly SpillDescriptor[] }>

parentPort.once('message', async (input: Input) => {
  try {
    if (!input || typeof input.requestId !== 'string' || !input.sessionId || !input.sessionGeneration ||
      !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0 || !Array.isArray(input.fragments) ||
      new Set(input.fragments.map(({ id }) => id)).size !== input.fragments.length) throw new Error('PROJECTION_SOURCE_PAGE_REQUEST_INVALID')
    if (input.sourceTruthSpills.length) {
      if (!input.sourceSpillRoot) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      try { for (const descriptor of input.sourceTruthSpills) readSourceTruthSpillSync(input.sourceSpillRoot, descriptor) }
      catch { throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE') }
    }
    const blobs = createSessionProjectionBlobStore(input.root)
    const messages = []
    for (const fragment of input.fragments) {
      if (!/^projection-[0-9a-f-]{36}\.blob$/.test(fragment.locator) || path.basename(fragment.locator) !== fragment.locator ||
        !Number.isSafeInteger(fragment.byteLength) || fragment.byteLength < 1 || !/^[a-f0-9]{64}$/.test(fragment.sha256)) {
        throw new Error('PROJECTION_SOURCE_FRAGMENT_REFERENCE_INVALID')
      }
      let envelope: unknown
      try { envelope = JSON.parse(await blobs.readVerified({ locator: fragment.locator, byteLength: fragment.byteLength, payloadDigest: fragment.sha256 })) }
      catch (error) { throw error instanceof Error ? error : new Error('PROJECTION_SOURCE_FRAGMENT_UNAVAILABLE') }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('PROJECTION_SOURCE_FRAGMENT_INVALID')
      const value = envelope as Record<string, unknown>
      const message = value.message as Record<string, unknown> | undefined
      if (Object.keys(value).sort().join(',') !== 'formatVersion,kind,message,sequence,sessionGeneration,sessionId,sourceRevision' ||
        value.formatVersion !== 1 || value.kind !== 'chatBodyV1-message' || value.sessionId !== input.sessionId ||
        value.sessionGeneration !== input.sessionGeneration || value.sourceRevision !== input.sourceRevision ||
        value.sequence !== fragment.sequence || !message || Object.keys(message).sort().join(',') !== 'content,id,role,timestamp' ||
        message.id !== fragment.id || (message.role !== 'user' && message.role !== 'assistant') ||
        typeof message.content !== 'string' || !Number.isSafeInteger(message.timestamp)) throw new Error('PROJECTION_SOURCE_FRAGMENT_INVALID')
      messages.push(Object.freeze({ id: message.id, role: message.role, timestamp: message.timestamp, content: message.content }))
    }
    parentPort!.postMessage({ requestId: input.requestId, result: { messages, workerThreadId: threadId } })
  } catch (error) {
    const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code : undefined
    parentPort!.postMessage({ requestId: input?.requestId,
      error: code ?? (error instanceof Error ? error.message : 'PROJECTION_SOURCE_PAGE_READ_FAILED') })
  } finally { parentPort!.close() }
})
