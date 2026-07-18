import fsc from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  captureFileIdentity,
  identitiesMatch,
  identityFromStat,
  type FileIdentity
} from '../safeAtomicWrite'
import { computeFileDigest } from './relocateDigest'

function openFlagsExclusive(): number {
  const c = fsc.constants
  let flags = c.O_WRONLY | c.O_CREAT | c.O_EXCL
  if (typeof c.O_NOFOLLOW === 'number') flags |= c.O_NOFOLLOW
  return flags
}

function openFlagsReadNoFollow(): number {
  const c = fsc.constants
  let flags = c.O_RDONLY
  if (typeof c.O_NOFOLLOW === 'number') flags |= c.O_NOFOLLOW
  return flags
}

export async function readFileMetadata(absPath: string): Promise<{
  identity: FileIdentity
  digest: string
  size: number
}> {
  const identity = await captureFileIdentity(absPath)
  const digest = await computeFileDigest(absPath)
  return { identity, digest, size: identity.size }
}

export async function fsyncFile(absPath: string): Promise<void> {
  const fh = await fs.open(absPath, openFlagsReadNoFollow())
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/** Creates backup with O_EXCL; fails if backup path already exists. */
export async function createExclusiveBackup(sourcePath: string, backupPath: string): Promise<FileIdentity> {
  await fs.copyFile(sourcePath, backupPath, fsc.constants.COPYFILE_EXCL)
  await fsyncFile(backupPath)
  const identity = await captureFileIdentity(backupPath)
  const digest = await computeFileDigest(backupPath)
  const sourceDigest = await computeFileDigest(sourcePath)
  if (digest !== sourceDigest) throw new Error('Backup digest mismatch')
  return identity
}

export async function copySourceToTemp(sourcePath: string, tempPath: string): Promise<{ identity: FileIdentity; digest: string }> {
  await fs.copyFile(sourcePath, tempPath, fsc.constants.COPYFILE_EXCL)
  await fsyncFile(tempPath)
  const identity = await captureFileIdentity(tempPath)
  const digest = await computeFileDigest(tempPath)
  return { identity, digest }
}

export async function deleteIfIdentityMatches(absPath: string, expected: FileIdentity): Promise<boolean> {
  try {
    const identity = await captureFileIdentity(absPath)
    if (!identitiesMatch(identity, expected)) return false
    await fs.unlink(absPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Atomically replace target with temp when temp identity matches expectation. */
export async function atomicReplaceWithTemp(tempPath: string, targetPath: string, tempIdentity: FileIdentity): Promise<void> {
  const current = await captureFileIdentity(tempPath)
  if (!identitiesMatch(current, tempIdentity)) throw new Error('Temp identity mismatch before commit')
  await fs.rename(tempPath, targetPath)
  const finalIdentity = await captureFileIdentity(targetPath)
  if (finalIdentity.size !== tempIdentity.size) throw new Error('Committed target size mismatch')
}

export async function sameDeviceRename(sourcePath: string, targetPath: string): Promise<void> {
  await fs.rename(sourcePath, targetPath)
}

export async function restoreBackupToTarget(backupPath: string, targetPath: string, backupIdentity: FileIdentity): Promise<void> {
  const current = await captureFileIdentity(backupPath)
  if (!identitiesMatch(current, backupIdentity)) throw new Error('Backup identity mismatch during restore')
  await fs.copyFile(backupPath, targetPath)
  await fsyncFile(targetPath)
}

export function buildControlledBackupPath(targetPath: string, operationId: string): string {
  const dir = path.dirname(targetPath)
  const base = path.basename(targetPath)
  return path.join(dir, `.${base}.spaceassistant-${operationId}.bak`)
}

export function buildControlledTempPath(targetPath: string, operationId: string): string {
  const dir = path.dirname(targetPath)
  const base = path.basename(targetPath)
  return path.join(dir, `.${base}.spaceassistant-${operationId}.tmp`)
}

export async function detectMoveMode(
  sourcePath: string,
  targetPath: string,
  mode: 'move' | 'copy'
): Promise<'same-device-move' | 'cross-device-move' | 'copy'> {
  if (mode === 'copy') return 'copy'
  const sourceStat = await fs.stat(sourcePath)
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  const targetParentStat = await fs.stat(path.dirname(targetPath))
  return sourceStat.dev === targetParentStat.dev ? 'same-device-move' : 'cross-device-move'
}

export async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath)
    return true
  } catch {
    return false
  }
}

export async function verifyIdentity(absPath: string, expected: FileIdentity): Promise<boolean> {
  try {
    const identity = await captureFileIdentity(absPath)
    return identitiesMatch(identity, expected)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export { identitiesMatch, identityFromStat }
