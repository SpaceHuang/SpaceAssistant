import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parentPort, threadId } from 'node:worker_threads'
import { iterateProjectionOutputMessages, type ProjectionOutputIdentity } from '../../application/projectionOutputManifest'
import type { ProjectionBuildOutputManifestRef } from '../../domain/projectionBuild'

if (!parentPort) throw new Error('projection final view worker requires a parent port')

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

parentPort.once('message', async (message: {
  requestId: string
  root: string
  output: ProjectionBuildOutputManifestRef
  identity: ProjectionOutputIdentity
  payloadIdentity: Readonly<{ formatVersion: 1; historyWatermarkJson: unknown }>
}) => {
  try {
    const blobs = {
      async readVerified(reference: ProjectionBuildOutputManifestRef): Promise<string> {
        if (!/^projection-[0-9a-f-]{36}\.blob$/.test(reference.locator) || path.basename(reference.locator) !== reference.locator) {
          throw new Error('PROJECTION_OUTPUT_LOCATOR_INVALID')
        }
        const filePath = path.join(message.root, reference.locator)
        const stat = await fs.lstat(filePath)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('PROJECTION_OUTPUT_FILE_INVALID')
        const bytes = await fs.readFile(filePath)
        if (bytes.byteLength !== reference.byteLength || digest(bytes) !== reference.payloadDigest) {
          throw new Error('PROJECTION_OUTPUT_BLOB_VERIFICATION_FAILED')
        }
        return bytes.toString('utf8')
      }
    }
    const envelope = JSON.stringify({ formatVersion: message.payloadIdentity.formatVersion,
      scopeKey: message.identity.scopeKey, specVersion: message.identity.specVersion,
      sessionId: message.identity.sessionId, sessionGeneration: message.identity.sessionGeneration,
      sourceIdentityJson: message.identity.sourceIdentityJson,
      historyWatermarkJson: message.payloadIdentity.historyWatermarkJson, messages: [] })
    const marker = '"messages":[]'
    const markerIndex = envelope.indexOf(marker)
    if (markerIndex < 0) throw new Error('PROJECTION_FINAL_VIEW_RESULT_INVALID')
    const prefix = Buffer.from(`${envelope.slice(0, markerIndex)}"messages":[`, 'utf8')
    const suffix = Buffer.from(`]${envelope.slice(markerIndex + marker.length)}`, 'utf8')
    const tempLocator = `.projection-${randomUUID()}.tmp`
    const tempPath = path.join(path.resolve(message.root), tempLocator)
    if (path.dirname(tempPath) !== path.resolve(message.root)) throw new Error('PROJECTION_FINAL_VIEW_ROOT_INVALID')
    const handle = await fs.open(tempPath, 'wx', 0o600)
    const hash = createHash('sha256')
    let byteLength = 0
    const write = async (chunk: Buffer) => {
      let offset = 0
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null)
        if (bytesWritten < 1) throw new Error('PROJECTION_FINAL_VIEW_WRITE_INCOMPLETE')
        offset += bytesWritten
      }
      hash.update(chunk)
      byteLength += chunk.byteLength
    }
    try {
      await write(prefix)
      let first = true
      for await (const projected of iterateProjectionOutputMessages(message.output, message.identity, blobs)) {
        if (!first) await write(Buffer.from(','))
        first = false
        await write(Buffer.from(JSON.stringify(projected), 'utf8'))
      }
      await write(suffix)
      await handle.sync()
    } catch (error) {
      await handle.close()
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
    await handle.close()
    const payloadDigest = hash.digest('hex')
    if (byteLength <= 256 * 1024) {
      const payload = await fs.readFile(tempPath, 'utf8')
      await fs.rm(tempPath, { force: true })
      parentPort!.postMessage({ requestId: message.requestId, result: { payload, byteLength, payloadDigest, workerThreadId: threadId } })
    } else {
      parentPort!.postMessage({ requestId: message.requestId, result: {
        stagedBlob: { tempLocator, byteLength, payloadDigest }, byteLength, payloadDigest, workerThreadId: threadId
      } })
    }
  } catch (error) {
    parentPort!.postMessage({ requestId: message.requestId, error: error instanceof Error ? error.message : 'PROJECTION_FINAL_VIEW_FAILED' })
  } finally {
    parentPort!.close()
  }
})
