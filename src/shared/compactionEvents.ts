export type CompactionEvent = {
  seq: number
  type: 'compaction_start' | 'compaction_summary' | 'compaction_end'
  payload: Record<string, unknown>
}

export type CommittedCompaction = {
  compactionId: string
  start: CompactionEvent
  summary: CompactionEvent
  end: CompactionEvent
}

export type CompactionReplay = { committed: CommittedCompaction[]; rejected: Array<{ compactionId?: string; reason: string }> }

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonicalize(entry)]))
  return value
}

export function computeCompactionSummaryHash(candidate: unknown): string {
  const text = JSON.stringify(canonicalize(candidate)) ?? 'null'
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  return typeof payload[key] === 'string' ? payload[key] as string : undefined
}

function validShadowRanges(payload: Record<string, unknown>): boolean {
  if (payload.shadowedRanges == null) return true
  return Array.isArray(payload.shadowedRanges) && payload.shadowedRanges.every((range) => {
    if (!range || typeof range !== 'object') return false
    return typeof (range as { start?: unknown }).start === 'string' && typeof (range as { end?: unknown }).end === 'string'
  })
}

export function foldCompactionEvents(events: readonly CompactionEvent[]): CompactionReplay {
  const starts = new Map<string, CompactionEvent>()
  const summaries = new Map<string, CompactionEvent>()
  const committed = new Map<string, CommittedCompaction>()
  const rejected: CompactionReplay['rejected'] = []
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const id = stringField(event.payload, 'compactionId')
    if (!id) { rejected.push({ reason: 'missing-compaction-id' }); continue }
    if (event.type === 'compaction_start') {
      if (starts.has(id)) rejected.push({ compactionId: id, reason: 'duplicate-start' })
      else starts.set(id, event)
      continue
    }
    if (event.type === 'compaction_summary') {
      if (!starts.has(id) || summaries.has(id)) rejected.push({ compactionId: id, reason: 'summary-without-unique-start' })
      else summaries.set(id, event)
      continue
    }
    if (event.payload.status !== 'committed' || committed.has(id)) { rejected.push({ compactionId: id, reason: 'not-committed-or-duplicate' }); continue }
    const start = starts.get(id)
    const summary = summaries.get(id)
    const startWindowId = stringField(start?.payload ?? {}, 'windowId')
    const summaryWindowId = stringField(summary?.payload ?? {}, 'windowId')
    const endWindowId = stringField(event.payload, 'windowId')
    const windowMatches = startWindowId == null || summaryWindowId == null || endWindowId == null || (startWindowId === summaryWindowId && summaryWindowId === endWindowId)
    const valid = start && summary && validShadowRanges(summary.payload) && windowMatches && event.payload.startSeq === start.seq && event.payload.summarySeq === summary.seq && event.payload.inputSurfaceFingerprint === start.payload.inputSurfaceFingerprint && event.payload.outputSurfaceFingerprint === summary.payload.outputSurfaceFingerprint && event.payload.summaryHash === summary.payload.summaryHash
    if (!valid) { rejected.push({ compactionId: id, reason: 'invalid-commit-references' }); continue }
    committed.set(id, { compactionId: id, start, summary, end: event })
  }
  return { committed: [...committed.values()].sort((a, b) => a.end.seq - b.end.seq), rejected }
}

export function countCommittedCompactions(replay: CompactionReplay, windowId: string): number {
  return replay.committed.filter((item) => item.start.payload.windowId === windowId || item.summary.payload.windowId === windowId || item.end.payload.windowId === windowId).length
}

export type CompactionMarker = { compactionId: string; windowId: string; outputSurfaceFingerprint: string }

/** 从唯一 replay 结果派生 UI marker；未提交/失配事务不会进入界面。 */
export function projectCompactionMarkers(replay: CompactionReplay, windowId?: string): CompactionMarker[] {
  return replay.committed.flatMap((item) => {
    const candidateWindowId = [item.end, item.summary, item.start].map((event) => event.payload.windowId).find((value): value is string => typeof value === 'string')
    const output = item.end.payload.outputSurfaceFingerprint
    if ((windowId && candidateWindowId !== windowId) || typeof candidateWindowId !== 'string' || typeof output !== 'string') return []
    return [{ compactionId: item.compactionId, windowId: candidateWindowId, outputSurfaceFingerprint: output }]
  })
}
