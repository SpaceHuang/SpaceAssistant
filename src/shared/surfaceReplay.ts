import type { CompactionReplay } from './compactionEvents'

export type SurfaceReplayItem = { id: string; required?: boolean }

export function surfaceItemIdentity(value: unknown, fallbackIndex: number): string {
  const explicit = value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
  if (explicit) return explicit
  const text = JSON.stringify(value) ?? `index:${fallbackIndex}`
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return `surface-${(hash >>> 0).toString(16).padStart(8, '0')}`
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
export function applyCommittedSurfaceShadow<T extends SurfaceReplayItem>(items: readonly T[], replay: CompactionReplay, requiredIds: readonly string[] = [], windowId?: string): T[] {
  const required = new Set(requiredIds)
  let currentSurface = [...items]
  for (const committed of replay.committed) {
    const committedWindowId = [committed.end, committed.summary, committed.start].map((event) => event.payload.windowId).find((value): value is string => typeof value === 'string')
    if (windowId && committedWindowId !== windowId) continue
    const ranges = committed.summary.payload.shadowedRanges
    if (!Array.isArray(ranges)) continue
    const shadowedIds = new Set<string>()
    let insertionIndex = -1
    for (const range of ranges) {
      if (!range || typeof range !== 'object') { shadowedIds.clear(); break }
      const start = (range as { start?: unknown }).start
      const end = (range as { end?: unknown }).end
      const rangeStart = currentSurface.findIndex((item) => item.id === start)
      const rangeEnd = currentSurface.findIndex((item) => item.id === end)
      if (rangeStart < 0 || rangeEnd < rangeStart) { shadowedIds.clear(); break }
      if (insertionIndex < 0) insertionIndex = rangeStart
      for (const item of currentSurface.slice(rangeStart, rangeEnd + 1)) shadowedIds.add(item.id)
    }
    if (shadowedIds.size === 0) continue
    currentSurface = currentSurface.filter((item) => !shadowedIds.has(item.id) || item.required || required.has(item.id))
    const candidate = committed.summary.payload.candidate
    const checkpointMessage = candidate && typeof candidate === 'object' ? (candidate as { checkpointMessage?: unknown }).checkpointMessage : undefined
    if (checkpointMessage && typeof checkpointMessage === 'object' && typeof (checkpointMessage as { id?: unknown }).id === 'string') currentSurface.splice(Math.min(insertionIndex, currentSurface.length), 0, checkpointMessage as T)
  }
  return currentSurface
}
