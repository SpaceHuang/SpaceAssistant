import { collectWriteDirCandidates, type WriteDirCandidate } from './writeDirCandidates'
import type { WriteDirCandidatePayload } from '../../src/shared/api'

const snapshots = new Map<string, { candidates: WriteDirCandidate[] }>()

function snapKey(requestId: string, sessionId: string): string {
  return `${requestId}\0${sessionId}`
}

export async function buildAndSnapshotCandidates(args: {
  requestId: string
  sessionId: string
  workDir: string
  fileStateCache: import('../fileStateCache').FileStateCache
  userMessages: string[]
  db?: import('../database').AppDatabase
}): Promise<WriteDirCandidatePayload[]> {
  const candidates = await collectWriteDirCandidates({
    workDir: args.workDir,
    sessionId: args.sessionId,
    fileStateCache: args.fileStateCache,
    userMessages: args.userMessages,
    db: args.db
  })
  snapshots.set(snapKey(args.requestId, args.sessionId), { candidates })
  return candidates.map((c) => ({
    key: c.key,
    dir: c.dir,
    label: c.label,
    ...(c.labelKind ? { labelKind: c.labelKind } : {})
  }))
}

export function resolveWriteDirCandidateDir(
  requestId: string,
  sessionId: string,
  key: string
): string | null {
  const snap = snapshots.get(snapKey(requestId, sessionId))
  if (!snap) return null
  const found = snap.candidates.find((c) => c.key === key)
  return found ? found.dir : null
}

export function clearWriteDirCandidateSnapshot(requestId: string, sessionId: string): void {
  snapshots.delete(snapKey(requestId, sessionId))
}
