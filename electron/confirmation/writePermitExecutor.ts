import fs from 'fs/promises'
import path from 'path'
import type { Stats } from 'fs'
import type { WritePathFact } from './extractors/writePathFacts'

export type PermittedWriteTarget = {
  targetPath: string
  parentReal: string
  existed: boolean
  existingStat: Stats | null
}

function identityMatches(a: WritePathFact['parentIdentity'], b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
}

export async function resolvePermittedWriteTarget(fact: WritePathFact): Promise<PermittedWriteTarget> {
  const parentStat = await fs.stat(fact.parentReal)
  if (!parentStat.isDirectory() || !identityMatches(fact.parentIdentity, parentStat) || await fs.realpath(fact.parentReal) !== fact.parentReal) {
    throw new Error('write-parent-identity-mismatch')
  }
  let targetStat: Stats | null = null
  try {
    const lstat = await fs.lstat(fact.normalizedPath)
    if (lstat.isSymbolicLink() || !lstat.isFile() || (lstat.nlink > 1)) throw new Error('write-target-type-mismatch')
    targetStat = await fs.stat(fact.normalizedPath)
    if (!fact.identity || targetStat.dev !== fact.identity.dev || targetStat.ino !== fact.identity.ino || targetStat.mode !== fact.identity.mode || targetStat.size !== fact.identity.size || targetStat.mtimeMs !== fact.identity.mtimeMs) {
      throw new Error('write-target-identity-mismatch')
    }
    if (await fs.realpath(fact.normalizedPath) !== fact.normalizedPath) throw new Error('write-target-realpath-mismatch')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (fact.targetKind === 'file' && !targetStat) throw new Error('write-target-disappeared')
  if (fact.targetKind === 'missing' && targetStat) throw new Error('write-target-appeared')
  if (fact.targetKind !== 'file' && fact.targetKind !== 'missing') throw new Error('write-target-kind-denied')
  if (path.dirname(fact.normalizedPath) !== fact.parentReal && !fact.normalizedPath.startsWith(fact.parentReal + path.sep)) throw new Error('write-target-outside-parent')
  return { targetPath: fact.normalizedPath, parentReal: fact.parentReal, existed: targetStat !== null, existingStat: targetStat }
}
