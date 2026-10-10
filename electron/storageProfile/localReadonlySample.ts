import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { runStorageProfileWorker } from './storageProfileWorkerClient'

export type LocalReadonlySample = Readonly<Record<string, unknown>>
type CandidateState = { dbPath: string; stat: fs.Stats; wal?: fs.Stats; shm?: fs.Stats }

export async function sampleLocalStorageReadonly(options: {
  candidates: string[]
  dryRun?: boolean
  runOverview?: (dbPath: string) => Promise<{ type: 'overview'; result: any }>
  inspect?: (dbPath: string) => CandidateState
}) {
  const candidateCount = options.candidates.length
  if (candidateCount !== 1) return { status: 'skipped', reason: candidateCount === 0 ? 'missing' : 'ambiguous', candidateCount }
  const dbPath = path.resolve(options.candidates[0]!)
  const inspect = options.inspect ?? inspectReadonlyCandidate
  let before: CandidateState
  try { before = inspect(dbPath) } catch (error) { return { status: 'skipped', reason: errorCode(error), identity: identity(dbPath) } }
  const dbIdentity = identity(dbPath)
  if (options.dryRun) return { status: 'ready', identity: dbIdentity, dbBytes: before.stat.size }

  const loopProbeStart = performance.now()
  const loopProbe = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - loopProbeStart), 0))
  const startedAt = performance.now()
  let response: Awaited<ReturnType<NonNullable<typeof options.runOverview>>>
  try { response = await (options.runOverview ?? defaultRunOverview)(dbPath) }
  catch { return { status: 'skipped', reason: 'worker-error', identity: dbIdentity, durationMs: round(performance.now() - startedAt), eventLoopDelayMs: round(await loopProbe) } }
  let after: CandidateState
  try { after = inspect(dbPath) } catch { return { status: 'skipped', reason: 'changed-or-unreadable', identity: dbIdentity } }
  const overview = response.result
  const common = { identity: dbIdentity, profileStatus: overview.status, sampledAt: overview.collectedAt, dbBytes: overview.database.dbBytes,
    walBytes: overview.database.walBytes, rowCounts: { messages: overview.tables.messages?.rows ?? null },
    spill: { classification: overview.spill.classification, files: overview.spill.files, observedBytes: overview.spill.observedBytes, complete: overview.spill.complete },
    status: overview.status, errorCodes: overview.spill.errorCodes, durationMs: round(performance.now() - startedAt), eventLoopDelayMs: round(await loopProbe) }
  if (sameState(before, after)) return { sampleStatus: 'sampled', ...common }
  return { sampleStatus: 'concurrent-change/inconclusive', ...common }
}

function inspectReadonlyCandidate(dbPath: string): CandidateState {
  const lst = fs.lstatSync(dbPath)
  if (lst.isSymbolicLink()) throw new Error('symlink')
  if (!lst.isFile()) throw new Error('not-regular-file')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try { db.prepare('SELECT name FROM sqlite_schema LIMIT 1').all() } finally { db.close() }
  const stat = fs.statSync(dbPath)
  const sidecar = (suffix: string) => { try { return fs.statSync(`${dbPath}${suffix}`) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error } }
  return { dbPath, stat, wal: sidecar('-wal'), shm: sidecar('-shm') }
}

async function defaultRunOverview(dbPath: string) {
  return await runStorageProfileWorker({ type: 'overview', dbPath }) as { type: 'overview'; result: any }
}

function sameState(left: CandidateState, right: CandidateState) {
  const fingerprint = (value?: fs.Stats) => value ? `${value.size}:${value.mtimeMs}:${value.ino}` : 'missing'
  return fingerprint(left.stat) === fingerprint(right.stat) && fingerprint(left.wal) === fingerprint(right.wal) && fingerprint(left.shm) === fingerprint(right.shm)
}

function identity(dbPath: string) { return createHash('sha256').update(path.resolve(dbPath)).digest('hex').slice(0, 16) }
function errorCode(error: unknown) {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing'
  if ((error as NodeJS.ErrnoException)?.code === 'EACCES' || (error as NodeJS.ErrnoException)?.code === 'EPERM') return 'permission-denied'
  const message = error instanceof Error ? error.message : ''
  return message === 'symlink' ? 'symlink' : message === 'not-regular-file' ? 'not-regular-file' : 'unreadable-or-corrupt'
}
function round(value: number) { return Number(value.toFixed(3)) }
