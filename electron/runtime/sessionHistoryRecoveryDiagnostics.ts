/** Converts repair callback failures to a small, content-free diagnostic enum. */
export type SessionHistoryRepairFailureCategory =
  | 'sqlite-busy'
  | 'sqlite-io-error'
  | 'sqlite-corrupt'
  | 'sqlite-constraint'
  | 'storage-object-missing'
  | 'storage-access-denied'
  | 'workspace-root-rejected'
  | 'canonical-projection-rejected'
  | 'projection-repair-failed'
  | 'unknown-repair-failure'

export function classifySessionHistoryRepairFailure(error: unknown): SessionHistoryRepairFailureCategory {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code.toUpperCase()
    : ''

  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return 'sqlite-busy'
  if (code === 'SQLITE_IOERR') return 'sqlite-io-error'
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return 'sqlite-corrupt'
  if (code.startsWith('SQLITE_CONSTRAINT')) return 'sqlite-constraint'
  if (code === 'ENOENT') return 'storage-object-missing'
  if (code === 'EACCES' || code === 'EPERM') return 'storage-access-denied'

  if (!(error instanceof Error)) return 'unknown-repair-failure'
  const message = error.message.toLowerCase()
  if (message.includes('configured workspace root')) return 'workspace-root-rejected'
  if (/\b(identity|owner|invalid|does not match|not belong|missing or not)\b/.test(message)) {
    return 'canonical-projection-rejected'
  }
  return 'projection-repair-failed'
}
