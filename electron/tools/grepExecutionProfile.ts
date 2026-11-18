import { createHash } from 'node:crypto'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import * as electron from 'electron'
import { inspectRipgrepBinary, resolveRipgrepBinary } from './ripgrepBinary'

export type GrepExecutionProfile = {
  engine: 'ripgrep' | 'walk'
  fingerprint: string
}

/** facts/final-check: binds a reusable grep scope to the engine semantics that will read it. */
export async function getGrepExecutionProfile(): Promise<GrepExecutionProfile | undefined> {
  const application = electron.app
  const packaged = application?.isPackaged === true
  const resolved = resolveRipgrepBinary({
    packaged,
    resourcesPath: process.resourcesPath ?? process.cwd(),
    developmentRoot: packaged ? undefined : application?.getAppPath?.() ?? path.resolve(__dirname, '../../..'),
    platform: process.platform,
    arch: process.arch
  })
  const availability = await inspectRipgrepBinary(resolved)
  if (!availability.available) {
    return { engine: 'walk', fingerprint: createHash('sha256').update('grep-walk-semantics-v1').digest('hex') }
  }
  try {
    const stat = await fsPromises.stat(resolved.path!)
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024) return undefined
    const bytes = await fsPromises.readFile(resolved.path!)
    return {
      engine: 'ripgrep',
      fingerprint: createHash('sha256').update('ripgrep-semantics-v1\0').update(bytes).digest('hex')
    }
  } catch { return undefined }
}
