import { createHash } from 'node:crypto'
import { withWikiWriteMutex } from './wikiWriteMutex'
import type { FileIdentity } from '../safeAtomicWrite'
import type { WikiFileStore } from './wikiFileStore'
import { normalizeWikiRelativePath } from './wikiPaths'

export class WikiWriteConflictError extends Error {
  readonly code = 'wiki-write-conflict'
  constructor(message = 'Wiki file changed since it was read.') { super(message); this.name = 'WikiWriteConflictError' }
}

export interface WikiWriteSnapshot { bytes: Buffer; identity: FileIdentity; sha256: string }

export interface WikiWriteService {
  read(relativePath: string): Promise<WikiWriteSnapshot>
  write(relativePath: string, body: string | Buffer, expectedIdentity?: FileIdentity | null, beforeCommit?: (targetPath: string) => Promise<void>): Promise<WikiWriteSnapshot>
}

export function createWikiWriteService(store: WikiFileStore): WikiWriteService {
  return {
    async read(relativePath) {
      const normalized = normalizeWikiRelativePath(relativePath)
      return withWikiWriteMutex(`${store.root}/${normalized}`, async () => {
        const bytes = await store.read(normalized)
        const identity = await store.identity(normalized)
        if (!identity) throw new WikiWriteConflictError('Wiki file disappeared while reading.')
        return { bytes, identity, sha256: hash(bytes) }
      })
    },
    async write(relativePath, body, expectedIdentity, beforeCommit) {
      const normalized = normalizeWikiRelativePath(relativePath)
      return withWikiWriteMutex(`${store.root}/${normalized}`, async () => {
        const current = await store.identity(normalized)
        if (expectedIdentity !== undefined && !sameIdentity(current, expectedIdentity)) throw new WikiWriteConflictError()
        if (beforeCommit) await beforeCommit(store.absolutePath(normalized))
        const latest = await store.identity(normalized)
        if (!sameIdentity(current, latest)) throw new WikiWriteConflictError()
        await store.write(normalized, body, current)
        const bytes = await store.read(normalized)
        const identity = await store.identity(normalized)
        if (!identity) throw new WikiWriteConflictError('Wiki file missing after write.')
        return { bytes, identity, sha256: hash(bytes) }
      })
    },
  }
}

function sameIdentity(left: FileIdentity | null, right: FileIdentity | null | undefined): boolean {
  if (right === undefined) return true
  if (left === null || right === null) return left === right
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.nlink === right.nlink
}

function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
