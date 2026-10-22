import { parentPort } from 'node:worker_threads'
import { readProjectionHistoryChunk, type ProjectionHistoryChunkPermit } from './projectionHistoryChunkReader'

if (!parentPort) throw new Error('projection history worker requires a parent port')

parentPort.once('message', (message: {
  requestId: string
  permit: ProjectionHistoryChunkPermit
  input: { afterSessionSequence: number; maxRows: number; maxBytes: number }
}) => {
  const result = readProjectionHistoryChunk(message.permit, message.input)
  parentPort!.postMessage({ requestId: message.requestId, result })
  parentPort!.close()
})
