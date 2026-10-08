import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const FILE_NAME = '.mcp-artifact-capacity.json'
export const MCP_ARTIFACT_QUOTA_BYTES = 256 * 1024 * 1024
export type McpArtifactCapacity = Readonly<{
  generation: number
  sweptGeneration: number
  estimatedBytes: number
  pending: readonly string[]
  dirty: boolean
  overQuota: boolean
}>
type State = { generation: number; sweptGeneration: number; sweepGeneration: number | null; estimatedBytes: number; pending: Record<string, number>; updatedAt: number }
const writes = new Map<string, Promise<void>>()
let capacityRequest: (() => void) | undefined

export function setMcpArtifactCapacityRequest(callback: (() => void) | undefined): void { capacityRequest = callback }
export function requestMcpArtifactCapacitySweep(): void { capacityRequest?.() }
function capacityPath(directory: string): string { return path.join(directory, FILE_NAME) }
function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}
function directorySyncUnsupported(error: unknown): boolean {
  return ['EINVAL', 'ENOTSUP', 'EISDIR'].includes(errorCode(error) ?? '')
}
function isState(value: unknown): value is State {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return Number.isSafeInteger(item.generation) && Number.isSafeInteger(item.sweptGeneration) && (item.sweepGeneration === null || Number.isSafeInteger(item.sweepGeneration)) && Number.isFinite(item.estimatedBytes) &&
    !!item.pending && typeof item.pending === 'object' && !Array.isArray(item.pending)
}
async function readState(directory: string): Promise<State | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(capacityPath(directory), 'utf8'))
    return isState(parsed) ? parsed : undefined
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    return undefined
  }
}
async function update(directory: string, change: (state: State) => State): Promise<State> {
  const filePath = capacityPath(directory)
  const previous = writes.get(filePath) ?? Promise.resolve()
  let result: State | undefined
  const next = previous.catch(() => undefined).then(async () => {
    const current = await readState(directory) ?? { generation: 0, sweptGeneration: -1, sweepGeneration: null, estimatedBytes: 0, pending: {}, updatedAt: 0 }
    result = change(current)
    await fs.mkdir(directory, { recursive: true })
    const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    const handle = await fs.open(temp, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify({ ...result, updatedAt: Date.now() })}\n`, 'utf8'); await handle.sync() } finally { await handle.close() }
    try { await fs.rename(temp, filePath) }
    catch (error) { await fs.unlink(temp).catch(() => undefined); throw error }
    try {
      const dirHandle = await fs.open(directory, 'r')
      try { await dirHandle.sync() } finally { await dirHandle.close() }
    } catch (error) { if (!directorySyncUnsupported(error)) throw error }
  })
  writes.set(filePath, next)
  try { await next } finally { if (writes.get(filePath) === next) writes.delete(filePath) }
  return result!
}
export async function readMcpArtifactCapacity(directory: string): Promise<McpArtifactCapacity> {
  await writes.get(capacityPath(directory))?.catch(() => undefined)
  const state = await readState(directory)
  if (!state) return { generation: 0, sweptGeneration: -1, estimatedBytes: 0, pending: [], dirty: true, overQuota: false }
  const pending = Object.keys(state.pending).sort()
  return { generation: state.generation, sweptGeneration: state.sweptGeneration, estimatedBytes: state.estimatedBytes,
    pending, dirty: state.generation !== state.sweptGeneration || pending.length > 0,
    overQuota: state.estimatedBytes + Object.values(state.pending).reduce((sum, bytes) => sum + bytes, 0) > MCP_ARTIFACT_QUOTA_BYTES }
}
export async function beginMcpArtifactSweep(directory: string): Promise<number> {
  const state = await update(directory, (current) => ({ ...current, sweepGeneration: current.generation }))
  return state.generation
}
export async function beginMcpArtifactPublish(directory: string, artifactId: string, expectedBytes: number): Promise<void> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new Error('invalid-mcp-artifact-byte-count')
  await update(directory, (state) => {
    if (Object.hasOwn(state.pending, artifactId)) return state
    return { ...state, generation: state.generation + 1, pending: { ...state.pending, [artifactId]: expectedBytes } }
  })
}
export async function completeMcpArtifactPublish(directory: string, artifactId: string, publishedBytes?: number): Promise<McpArtifactCapacity> {
  const state = await update(directory, (current) => {
    const pending = { ...current.pending }
    const bytes = pending[artifactId] ?? publishedBytes ?? 0
    delete pending[artifactId]
    return { ...current, generation: current.generation + 1, estimatedBytes: current.estimatedBytes + bytes, pending }
  })
  const result = await readMcpArtifactCapacity(directory)
  if (result.overQuota || state.sweepGeneration !== null) requestMcpArtifactCapacitySweep()
  return { ...result, generation: state.generation }
}
export async function settleMcpArtifactSweep(directory: string, observedGeneration: number, remainingBytes: number): Promise<McpArtifactCapacity> {
  const state = await update(directory, (current) => {
    const stable = current.generation === observedGeneration
    return { ...current, estimatedBytes: remainingBytes,
      sweptGeneration: stable ? observedGeneration : current.sweptGeneration, pending: {}, sweepGeneration: null }
  })
  const result = await readMcpArtifactCapacity(directory)
  if (result.dirty) requestMcpArtifactCapacitySweep()
  return { ...result, generation: state.generation }
}
