import { parentPort } from 'node:worker_threads'
import { collectSessionStorageAudit, collectSessionStorageOverview } from '../database/sessionStorageProfile'

if (!parentPort) throw new Error('storage profile worker requires parent port')

type Request = { id: string; type: 'overview' | 'audit'; dbPath: string }

parentPort.once('message', (request: Request) => {
  try {
    if (!request || typeof request.id !== 'string' || typeof request.dbPath !== 'string' || !['overview', 'audit'].includes(request.type)) {
      parentPort!.postMessage({ id: request?.id ?? '', error: 'STORAGE_PROFILE_INVALID_REQUEST' })
      return
    }
    const result = request.type === 'overview' ? collectSessionStorageOverview(request.dbPath) : collectSessionStorageAudit(request.dbPath)
    parentPort!.postMessage({ id: request.id, type: request.type, result })
  } catch (error) {
    parentPort!.postMessage({ id: request?.id ?? '', error: 'STORAGE_PROFILE_WORKER_ERROR' })
  }
  parentPort!.close()
})
