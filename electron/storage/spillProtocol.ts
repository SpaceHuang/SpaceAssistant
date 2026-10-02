import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export type SpillDescriptor = Readonly<{
  version: 1
  kind: 'source-of-truth' | 'degradable'
  locator: string
  byteLength: number
  sha256: string
  createdAt: number
  head: string
  tail: string
}>

export class SpillContentUnavailableError extends Error {
  readonly code = 'SPILL_CONTENT_UNAVAILABLE'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SpillContentUnavailableError'
  }
}

export function readSourceTruthSpillSync(root: string, descriptor: SpillDescriptor): string {
  if (descriptor.kind !== 'source-of-truth') throw new Error('expected source-of-truth spill')
  try {
    if (!/^[0-9a-f-]+\.spill$/.test(descriptor.locator) || path.basename(descriptor.locator) !== descriptor.locator) throw new Error('spill locator is invalid')
    const bytes = fs.readFileSync(path.join(root, descriptor.locator))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength !== descriptor.byteLength || sha256 !== descriptor.sha256) throw new Error('spill byte length or checksum mismatch')
    return bytes.toString('utf8')
  } catch (cause) {
    throw new SpillContentUnavailableError(`spill content unavailable: ${descriptor.locator}`, { cause })
  }
}
