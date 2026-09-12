import type { CompactionReplay } from './compactionEvents'
import { buildRequestHeaderPayload } from './requestContext'

export type SurfaceReplayItem = { id: string; required?: boolean }

export function surfaceItemIdentity(value: unknown, fallbackIndex: number): string {
  if (value && typeof value === 'object' && 'role' in value && 'content' in value) {
    const message = value as { role?: unknown; content?: unknown }
    const text = JSON.stringify({ role: message.role, content: message.content })
    let hash = 2166136261
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
    return `surface-${(hash >>> 0).toString(16).padStart(8, '0')}`
  }
  const explicit = value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
  if (explicit) return explicit
  const text = JSON.stringify(value) ?? `index:${fallbackIndex}`
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return `surface-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function surfaceItemIdentities(values: readonly unknown[]): string[] {
  const counts = new Map<string, number>()
  return values.map((value, index) => {
    const base = surfaceItemIdentity(value, index)
    const occurrence = counts.get(base) ?? 0
    counts.set(base, occurrence + 1)
    return occurrence === 0 ? base : `${base}#${occurrence}`
  })
}

export function computeReplaySurfaceFingerprint(system: string, surface: readonly unknown[]): string {
  return buildRequestHeaderPayload({ requestId: 'replay', system, tools: [], messages: surface.map((message) => {
    const source = message && typeof message === 'object' ? message as { role?: unknown; content?: unknown } : {}
    return { role: source.role, content: source.content }
  }) }).surfaceSnapshot.fingerprint
}

export function computeShadowedRanges<T extends SurfaceReplayItem>(before: readonly T[], after: readonly T[]): Array<{ start: string; end: string }> {
  const retained = new Set(after.map((item) => item.id))
  const removed = before.filter((item) => !retained.has(item.id))
  const ranges: Array<{ start: string; end: string }> = []
  for (const item of removed) {
    const previous = ranges[ranges.length - 1]
    if (previous && before.findIndex((candidate) => candidate.id === item.id) === before.findIndex((candidate) => candidate.id === previous.end) + 1) previous.end = item.id
    else ranges.push({ start: item.id, end: item.id })
  }
  return ranges
}

/** 将已提交压缩记录的 shadowedRanges 应用到模型面；调用方仍保留完整 facts。 */
export function applyCommittedSurfaceShadow<T extends SurfaceReplayItem>(items: readonly T[], replay: CompactionReplay, requiredIds: readonly string[] = [], windowId?: string, fingerprint?: (items: readonly T[]) => string): T[] {
  const required = new Set(requiredIds)
  let currentSurface = [...items]
  const initialIdentities = surfaceItemIdentities(items)
  const stableIdentities = new Map(items.map((item, index) => [item.id, initialIdentities[index] ?? surfaceItemIdentity(item, index)]))
  for (const committed of replay.committed) {
    const committedWindowId = [committed.end, committed.summary, committed.start].map((event) => event.payload.windowId).find((value): value is string => typeof value === 'string')
    if (windowId && committedWindowId !== windowId) continue
    const expectedInput = committed.start.payload.inputSurfaceFingerprint
    const surfaceBeforeRecord = [...currentSurface]
    const ranges = committed.summary.payload.shadowedRanges
    if (!Array.isArray(ranges)) continue
    const persistedBoundary = committed.start.payload.surfaceBoundaryId
    const rangeBoundary = ranges.reduce<string | undefined>((last, range) => {
      if (!range || typeof range !== 'object') return last
      return typeof (range as { end?: unknown }).end === 'string' ? (range as { end: string }).end : last
    }, undefined)
    const expectedBoundaryIndex = fingerprint && typeof expectedInput === 'string'
      ? currentSurface.findIndex((_, index) => fingerprint(currentSurface.slice(0, index + 1)) === expectedInput)
      : -1
    const boundaryEnd = expectedBoundaryIndex >= 0 ? currentSurface[expectedBoundaryIndex]?.id : (typeof persistedBoundary === 'string' ? persistedBoundary : rangeBoundary)
    const currentIdentities = currentSurface.map((item, index) => stableIdentities.get(item.id) ?? surfaceItemIdentity(item, index))
    const boundaryIndex = boundaryEnd ? currentSurface.findIndex((item, index) => item.id === boundaryEnd || currentIdentities[index] === boundaryEnd) : -1
    const inputSurface = boundaryIndex >= 0 ? currentSurface.slice(0, boundaryIndex + 1) : currentSurface
    const historicalIds = new Set(inputSurface.map((item) => item.id))
    if (fingerprint && typeof expectedInput === 'string' && fingerprint(inputSurface) !== expectedInput) continue
    const shadowedIds = new Set<string>()
    let insertionIndex = -1
    for (const range of ranges) {
      if (!range || typeof range !== 'object') { shadowedIds.clear(); break }
      const start = (range as { start?: unknown }).start
      const end = (range as { end?: unknown }).end
      const rangeStart = currentSurface.findIndex((item, index) => item.id === start || currentIdentities[index] === start)
      const rangeEnd = currentSurface.findIndex((item, index) => item.id === end || currentIdentities[index] === end)
      if (rangeStart < 0 || rangeEnd < rangeStart) { shadowedIds.clear(); break }
      if (insertionIndex < 0) insertionIndex = rangeStart
      for (const item of currentSurface.slice(rangeStart, rangeEnd + 1)) shadowedIds.add(item.id)
    }
    if (shadowedIds.size === 0) continue
    currentSurface = currentSurface.filter((item) => !shadowedIds.has(item.id) || item.required || required.has(item.id))
    const candidate = committed.summary.payload.candidate
    const checkpointMessage = candidate && typeof candidate === 'object' ? (candidate as { checkpointMessage?: unknown }).checkpointMessage : undefined
    if (checkpointMessage && typeof checkpointMessage === 'object' && typeof (checkpointMessage as { id?: unknown }).id === 'string') {
      const checkpoint = checkpointMessage as T
      currentSurface.splice(Math.min(insertionIndex, currentSurface.length), 0, checkpoint)
      const replayIdentity = candidate && typeof candidate === 'object' ? (candidate as { checkpointReplayIdentity?: unknown }).checkpointReplayIdentity : undefined
      stableIdentities.set(checkpoint.id, typeof replayIdentity === 'string' ? replayIdentity : surfaceItemIdentity(checkpoint, insertionIndex))
    }
    const expectedOutput = committed.summary.payload.outputSurfaceFingerprint ?? committed.end.payload.outputSurfaceFingerprint
    const outputSurface = boundaryIndex >= 0 ? currentSurface.filter((item) => historicalIds.has(item.id) || item.id === checkpointMessageId(committed)) : currentSurface
    if (fingerprint && typeof expectedOutput === 'string' && fingerprint(outputSurface) !== expectedOutput) {
      currentSurface = surfaceBeforeRecord
      break
    }
  }
  return currentSurface
}

function checkpointMessageId(committed: CompactionReplay['committed'][number]): string | undefined {
  const candidate = committed.summary.payload.candidate
  const checkpoint = candidate && typeof candidate === 'object' ? (candidate as { checkpointMessage?: unknown }).checkpointMessage : undefined
  return checkpoint && typeof checkpoint === 'object' && typeof (checkpoint as { id?: unknown }).id === 'string' ? (checkpoint as { id: string }).id : undefined
}
