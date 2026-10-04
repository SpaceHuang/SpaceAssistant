import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const SPILL_DESCRIPTOR_VERSION = 1 as const
export const SOURCE_TRUTH_SPILL_MARKER = '__spaceassistant_spill_v1' as const
export const SESSION_TRANSCRIPT_SPILL_MARKER = '__spaceassistant_session_transcript_spill_v1' as const
export const SPILL_MARKER_KEYS = [SOURCE_TRUTH_SPILL_MARKER, SESSION_TRANSCRIPT_SPILL_MARKER] as const

export type SpillDescriptor = Readonly<{
  version: typeof SPILL_DESCRIPTOR_VERSION
  kind: 'source-of-truth' | 'degradable'
  locator: string
  byteLength: number
  sha256: string
  createdAt: number
  head: string
  tail: string
}>

/** Strictly parse every recognized spill locator before any canonical-reference based cleanup. */
export function collectSpillDescriptorsStrict(value: unknown, output: SpillDescriptor[] = []): SpillDescriptor[] {
  if (value === null || typeof value !== 'object') return output
  if (Array.isArray(value)) {
    for (const item of value) collectSpillDescriptorsStrict(item, output)
    return output
  }
  const object = value as Record<string, unknown>
  const markerKeys = Object.keys(object).filter((key) => key.startsWith('__spaceassistant_') && key.toLowerCase().includes('spill'))
  if (markerKeys.some((key) => !(SPILL_MARKER_KEYS as readonly string[]).includes(key))) {
    throw new Error('source-truth spill marker is unsupported')
  }
  const descriptorKey = Object.hasOwn(object, SOURCE_TRUTH_SPILL_MARKER) ? SOURCE_TRUTH_SPILL_MARKER
    : Object.hasOwn(object, SESSION_TRANSCRIPT_SPILL_MARKER) ? SESSION_TRANSCRIPT_SPILL_MARKER : undefined
  const descriptorLike = typeof object.locator === 'string' && object.locator.endsWith('.spill') &&
    ('version' in object || 'kind' in object || 'sha256' in object || 'byteLength' in object)
  const isInlineDescriptor = descriptorLike || object.version === SPILL_DESCRIPTOR_VERSION && (object.kind === 'source-of-truth' || object.kind === 'degradable')
  if (descriptorKey || isInlineDescriptor) {
    const descriptor = descriptorKey ? object[descriptorKey] : object
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error('source-truth spill descriptor is malformed')
    const candidate = descriptor as Record<string, unknown>
    if (candidate.version !== SPILL_DESCRIPTOR_VERSION || (candidate.kind !== 'source-of-truth' && candidate.kind !== 'degradable') ||
      typeof candidate.locator !== 'string' || !/^[0-9a-f-]+\.spill$/.test(candidate.locator) ||
      path.basename(candidate.locator) !== candidate.locator || !Number.isSafeInteger(candidate.byteLength) || Number(candidate.byteLength) < 0 ||
      typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.sha256) ||
      typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt) ||
      typeof candidate.head !== 'string' || typeof candidate.tail !== 'string') {
      throw new Error('source-truth spill descriptor is malformed')
    }
    output.push(candidate as unknown as SpillDescriptor)
    return output
  }
  for (const item of Object.values(object)) collectSpillDescriptorsStrict(item, output)
  return output
}

/** Strictly discover source-truth locators before deleting the canonical rows that own them. */
export function collectSourceTruthSpillLocators(value: unknown, output = new Set<string>()): Set<string> {
  for (const descriptor of collectSpillDescriptorsStrict(value)) {
    if (descriptor.kind === 'source-of-truth') output.add(descriptor.locator)
  }
  return output
}

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
