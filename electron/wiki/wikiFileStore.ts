import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { captureFileIdentity, identityFromStat, safeAtomicWrite, type FileIdentity } from '../safeAtomicWrite'
import { resolveWikiServicePath } from './wikiPaths'

export interface WikiCatalog {
  formatVersion: 1
  pages: Array<{ pageId: string; path: string; revision?: number; contentHash?: string; title?: string; categoryId?: string; summary?: string; parentPageId?: string | null; sourceRefs?: Array<{ sourceId: string; sourceRevision: number }> }>
}

export interface WikiFileStore {
  readonly root: string
  read(relativePath: string): Promise<Buffer>
  readText(relativePath: string): Promise<string>
  identity(relativePath: string): Promise<FileIdentity | null>
  absolutePath(relativePath: string): string
  write(relativePath: string, body: string | Buffer, expectedIdentity?: FileIdentity | null): Promise<FileIdentity>
  writeImmutable(relativePath: string, body: string | Buffer): Promise<FileIdentity>
  remove(relativePath: string, expectedIdentity?: FileIdentity): Promise<void>
  readCatalog(): Promise<WikiCatalog | undefined>
  writeCatalog(catalog: WikiCatalog): Promise<FileIdentity>
}

export function createWikiFileStore(wikiRoot: string): WikiFileStore {
  const root = path.resolve(wikiRoot)
  const canonicalRootPromise = realpath(root)
  async function parentFor(relativePath: string): Promise<{ target: string; parent: string; parentIdentity: FileIdentity }> {
    const canonicalRoot = await canonicalRootPromise
    const target = resolveWikiServicePath(canonicalRoot, relativePath)
    const parent = path.dirname(target)
    await mkdir(parent, { recursive: true })
    const parentStat = await stat(parent)
    if (!parentStat.isDirectory() || !isWithinRoot(canonicalRoot, await realpath(parent))) throw new Error('Wiki parent directory identity is invalid.')
    let current = canonicalRoot
    const relativeParent = path.relative(canonicalRoot, parent)
    for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Wiki path contains a symbolic link.')
    }
    return { target, parent, parentIdentity: identityFromStat(parentStat) }
  }
  return {
    get root() { return root },
    absolutePath(relativePath) { return resolveWikiServicePath(root, relativePath) },
    async read(relativePath) {
      const target = resolveWikiServicePath(await canonicalRootPromise, relativePath)
      const bytes = await readFile(target)
      const targetStat = await lstat(target)
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error('Wiki target is not a regular file.')
      return bytes
    },
    async readText(relativePath) { return (await this.read(relativePath)).toString('utf8') },
    async identity(relativePath) {
      const target = resolveWikiServicePath(await canonicalRootPromise, relativePath)
      try { return await captureFileIdentity(target) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    },
    async write(relativePath, body, expected) {
      const { target, parent } = await parentFor(relativePath)
      let expectedIdentity = expected
      if (expected === undefined) {
        try { expectedIdentity = await captureFileIdentity(target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      return safeAtomicWrite({ targetPath: target, parentReal: parent, body, expectedIdentity: expectedIdentity ?? null })
    },
    async writeImmutable(relativePath, body) {
      const { target, parent } = await parentFor(relativePath)
      return safeAtomicWrite({ targetPath: target, parentReal: parent, body, expectedIdentity: null })
    },
    async remove(relativePath, expectedIdentity) {
      const target = resolveWikiServicePath(await canonicalRootPromise, relativePath)
      if (expectedIdentity) {
        const current = await captureFileIdentity(target)
        if (current.dev !== expectedIdentity.dev || current.ino !== expectedIdentity.ino || current.size !== expectedIdentity.size || current.mtimeMs !== expectedIdentity.mtimeMs) throw new Error('Wiki target identity changed.')
      }
      await rm(target)
    },
    async readCatalog() {
      try { return JSON.parse(await this.readText('.wiki-service/catalog.json')) as WikiCatalog }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    },
    async writeCatalog(catalog) { return this.write('.wiki-service/catalog.json', `${JSON.stringify(catalog, null, 2)}\n`) },
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
