import fs from 'node:fs/promises'
import { ErrorCodes } from '../../src/shared/errorCodes'

export type OutputPathKind = 'file' | 'directory' | 'auto'

/** Resolves existing targets from the filesystem; a model declaration cannot override lstat. */
export async function resolveOutputPathKind(input: {
  targetPath: string
  /** Original path before any normalization, so a user-declared trailing slash is retained. */
  requestedPath?: string
  declaredKind: OutputPathKind
}): Promise<OutputPathKind> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(input.targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (input.declaredKind === 'auto' && /[\\/]$/.test(input.requestedPath ?? input.targetPath)) return 'directory'
      return input.declaredKind
    }
    throw error
  }

  const actualKind: Exclude<OutputPathKind, 'auto'> = stat.isDirectory() ? 'directory' : 'file'
  if (input.declaredKind !== 'auto' && input.declaredKind !== actualKind) {
    throw new Error(`${ErrorCodes.ARTIFACT_PATH_TYPE_CONFLICT}: target is an existing ${actualKind}`)
  }
  return actualKind
}
