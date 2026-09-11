import type { CompactionReplay } from './compactionEvents'

export type SurfaceReplayItem = { id: string; required?: boolean }

/** 将已提交压缩记录的 shadowedRanges 应用到模型面；调用方仍保留完整 facts。 */
export function applyCommittedSurfaceShadow<T extends SurfaceReplayItem>(items: readonly T[], replay: CompactionReplay, requiredIds: readonly string[] = []): T[] {
  const required = new Set(requiredIds)
  const shadowed = new Set<string>()
  for (const committed of replay.committed) {
    const ranges = committed.summary.payload.shadowedRanges
    if (!Array.isArray(ranges)) continue
    for (const range of ranges) {
      if (!range || typeof range !== 'object') continue
      const start = (range as { start?: unknown }).start
      const end = (range as { end?: unknown }).end
      const startIndex = items.findIndex((item) => item.id === start)
      const endIndex = items.findIndex((item) => item.id === end)
      if (startIndex < 0 || endIndex < startIndex) continue
      for (const item of items.slice(startIndex, endIndex + 1)) shadowed.add(item.id)
    }
  }
  return items.filter((item) => !shadowed.has(item.id) || item.required || required.has(item.id))
}
