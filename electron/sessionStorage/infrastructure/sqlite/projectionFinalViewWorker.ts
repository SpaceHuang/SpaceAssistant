import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parentPort, threadId } from 'node:worker_threads'
import { materializeProjectionOutputManifest, type ProjectionOutputIdentity } from '../../application/projectionOutputManifest'
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
    const messages = await materializeProjectionOutputManifest(message.output, message.identity, blobs)
    const payload = JSON.stringify({ formatVersion: message.payloadIdentity.formatVersion,
      scopeKey: message.identity.scopeKey, specVersion: message.identity.specVersion,
      sessionId: message.identity.sessionId, sessionGeneration: message.identity.sessionGeneration,
      sourceIdentityJson: message.identity.sourceIdentityJson,
      historyWatermarkJson: message.payloadIdentity.historyWatermarkJson, messages })
    const byteLength = Buffer.byteLength(payload)
    parentPort!.postMessage({ requestId: message.requestId, result: { payload, byteLength, payloadDigest: digest(payload), workerThreadId: threadId } })
  } catch (error) {
    parentPort!.postMessage({ requestId: message.requestId, error: error instanceof Error ? error.message : 'PROJECTION_FINAL_VIEW_FAILED' })
  } finally {
    parentPort!.close()
  }
})
