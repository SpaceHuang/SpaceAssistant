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

export type SpillDescriptorReference = Readonly<{ path: string; descriptor: SpillDescriptor }>

const KNOWN_SPILL_MARKERS = new Set(['__spaceassistant_spill_v1', '__spaceassistant_session_transcript_spill_v1'])
const INLINE_DESCRIPTOR_KEYS = new Set(['version', 'kind', 'locator', 'byteLength', 'sha256', 'createdAt', 'head', 'tail'])

function isSpillMarker(key: string): boolean {
  return key.startsWith('__spaceassistant_') && key.toLowerCase().includes('spill')
}

function pointerChild(parent: string, key: string | number): string {
  return `${parent}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`
}

function parseSpillDescriptor(value: unknown): SpillDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('source-truth spill descriptor is malformed')
  const candidate = value as Record<string, unknown>
  if (candidate.version !== 1 || (candidate.kind !== 'source-of-truth' && candidate.kind !== 'degradable') ||
    typeof candidate.locator !== 'string' || !/^[0-9a-f-]+\.spill$/.test(candidate.locator) ||
    path.basename(candidate.locator) !== candidate.locator || !Number.isSafeInteger(candidate.byteLength) || Number(candidate.byteLength) < 0 ||
    typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.sha256) ||
    typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt) ||
    typeof candidate.head !== 'string' || typeof candidate.tail !== 'string') {
    throw new Error('source-truth spill descriptor is malformed')
  }
  return candidate as unknown as SpillDescriptor
}

/** Yield strictly validated descriptors with stable RFC 6901 paths and bounded result retention. */
export function* iterateSpillDescriptorReferencesStrict(value: unknown): Generator<SpillDescriptorReference> {
  function* visit(current: unknown, currentPath: string): Generator<SpillDescriptorReference> {
    if (current === null || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) yield* visit(current[index], pointerChild(currentPath, index))
      return
    }
    const object = current as Record<string, unknown>
    const keys = Object.keys(object)
    const markerKeys = keys.filter(isSpillMarker)
    if (markerKeys.some((key) => !KNOWN_SPILL_MARKERS.has(key))) throw new Error('source-truth spill marker is unsupported')

    const descriptorLike = typeof object.locator === 'string' && object.locator.endsWith('.spill') &&
      ('version' in object || 'kind' in object || 'sha256' in object || 'byteLength' in object)
    const inline = descriptorLike || object.version === 1 && (object.kind === 'source-of-truth' || object.kind === 'degradable')
    if (inline && markerKeys.length > 0) throw new Error('source-truth spill descriptor is ambiguous')

    if (inline) {
      const extraKeys = keys.filter((key) => !INLINE_DESCRIPTOR_KEYS.has(key))
      for (const key of extraKeys) {
        if (containsSpillReference(object[key])) throw new Error('source-truth spill descriptor is ambiguous')
      }
      yield { path: currentPath, descriptor: parseSpillDescriptor(object) }
      return
    }

    for (const marker of markerKeys) yield { path: pointerChild(currentPath, marker), descriptor: parseSpillDescriptor(object[marker]) }
    for (const key of keys) if (!markerKeys.includes(key)) yield* visit(object[key], pointerChild(currentPath, key))
  }

  yield* visit(value, '')
}

function containsSpillReference(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsSpillReference)
  const object = value as Record<string, unknown>
  if (Object.keys(object).some((key) => isSpillMarker(key) || KNOWN_SPILL_MARKERS.has(key))) return true
  if (object.version === 1 && (object.kind === 'source-of-truth' || object.kind === 'degradable') && typeof object.locator === 'string') return true
  return Object.values(object).some(containsSpillReference)
}

/** Strictly parse every recognized spill locator before any canonical-reference based cleanup. */
export function collectSpillDescriptorsStrict(value: unknown, output: SpillDescriptor[] = []): SpillDescriptor[] {
  for (const reference of iterateSpillDescriptorReferencesStrict(value)) output.push(reference.descriptor)
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
