import { describe, expect, it } from 'vitest'
import { applyCommittedSurfaceShadow, computeShadowedRanges, surfaceItemIdentity } from './surfaceReplay'
import { computeCompactionSummaryHash, foldCompactionEvents } from './compactionEvents'

describe('surface replay', () => {
  it('uses content identity when a surface item has no explicit id', () => {
    expect(surfaceItemIdentity({ role: 'user', content: 'same' }, 0)).toBe(surfaceItemIdentity({ role: 'user', content: 'same' }, 9))
  })
  it('computes contiguous shadow ranges for reset output', () => {
    expect(computeShadowedRanges([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }], [{ id: 'a' }, { id: 'c' }, { id: 'e' }])).toEqual([{ start: 'b', end: 'b' }, { start: 'd', end: 'd' }])
  })
  it('hides committed shadow ranges without deleting facts or required input', () => {
    const replay = foldCompactionEvents([
      { seq: 1, type: 'compaction_start', payload: { compactionId: 'c', windowId: 'w', inputSurfaceFingerprint: 'in' } },
      { seq: 2, type: 'compaction_summary', payload: { compactionId: 'c', windowId: 'w', summaryHash: 'h', outputSurfaceFingerprint: 'out', shadowedRanges: [{ start: 'old-1', end: 'old-2' }] } },
      { seq: 3, type: 'compaction_end', payload: { compactionId: 'c', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: 'h' } }
    ])
    const facts = [{ id: 'old-1' }, { id: 'old-2' }, { id: 'current', required: true }, { id: 'tail' }]
    expect(applyCommittedSurfaceShadow(facts, replay, ['old-2'], 'w')).toEqual([{ id: 'old-2' }, { id: 'current', required: true }, { id: 'tail' }])
    expect(facts).toHaveLength(4)
  })

  it('does not apply another window shadow', () => {
    const replay = foldCompactionEvents([
      { seq: 1, type: 'compaction_start', payload: { compactionId: 'other', windowId: 'other', inputSurfaceFingerprint: 'in' } },
      { seq: 2, type: 'compaction_summary', payload: { compactionId: 'other', windowId: 'other', summaryHash: 'h', outputSurfaceFingerprint: 'out', shadowedRanges: [{ start: 'old-1', end: 'old-1' }] } },
      { seq: 3, type: 'compaction_end', payload: { compactionId: 'other', windowId: 'other', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: 'h' } }
    ])
    expect(applyCommittedSurfaceShadow([{ id: 'old-1' }], replay, [], 'current')).toEqual([{ id: 'old-1' }])
  })

  it('replays the committed checkpoint before the retained surface', () => {
    const candidate = { checkpointMessage: { id: 'checkpoint-1', role: 'user', content: 'summary' }, shadowedRanges: [{ start: 'old-1', end: 'old-1' }] }
    const replay = foldCompactionEvents([
      { seq: 1, type: 'compaction_start', payload: { compactionId: 'checkpointed', windowId: 'w', inputSurfaceFingerprint: 'in' } },
      { seq: 2, type: 'compaction_summary', payload: { compactionId: 'checkpointed', windowId: 'w', candidate, summaryHash: computeCompactionSummaryHash(candidate), outputSurfaceFingerprint: 'out', shadowedRanges: candidate.shadowedRanges } },
      { seq: 3, type: 'compaction_end', payload: { compactionId: 'checkpointed', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: computeCompactionSummaryHash(candidate) } }
    ])
    expect(applyCommittedSurfaceShadow([{ id: 'old-1' }, { id: 'tail' }], replay, [], 'w')).toEqual([{ id: 'checkpoint-1', role: 'user', content: 'summary' }, { id: 'tail' }])
  })

  it('applies consecutive compactions in order using the prior checkpoint surface', () => {
    const first = { checkpointMessage: { id: 'checkpoint-1', role: 'user', content: 'summary 1' }, shadowedRanges: [{ start: 'old-1', end: 'old-2' }] }
    const second = { checkpointMessage: { id: 'checkpoint-2', role: 'user', content: 'summary 2' }, shadowedRanges: [{ start: 'checkpoint-1', end: 'new-1' }] }
    const events = [
      { seq: 1, type: 'compaction_start' as const, payload: { compactionId: 'c1', windowId: 'w', inputSurfaceFingerprint: 'in-1' } },
      { seq: 2, type: 'compaction_summary' as const, payload: { compactionId: 'c1', windowId: 'w', candidate: first, summaryHash: computeCompactionSummaryHash(first), outputSurfaceFingerprint: 'out-1', shadowedRanges: first.shadowedRanges } },
      { seq: 3, type: 'compaction_end' as const, payload: { compactionId: 'c1', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in-1', outputSurfaceFingerprint: 'out-1', summaryHash: computeCompactionSummaryHash(first) } },
      { seq: 4, type: 'compaction_start' as const, payload: { compactionId: 'c2', windowId: 'w', inputSurfaceFingerprint: 'in-2' } },
      { seq: 5, type: 'compaction_summary' as const, payload: { compactionId: 'c2', windowId: 'w', candidate: second, summaryHash: computeCompactionSummaryHash(second), outputSurfaceFingerprint: 'out-2', shadowedRanges: second.shadowedRanges } },
      { seq: 6, type: 'compaction_end' as const, payload: { compactionId: 'c2', windowId: 'w', status: 'committed', startSeq: 4, summarySeq: 5, inputSurfaceFingerprint: 'in-2', outputSurfaceFingerprint: 'out-2', summaryHash: computeCompactionSummaryHash(second) } }
    ]
    expect(applyCommittedSurfaceShadow([{ id: 'old-1' }, { id: 'old-2' }, { id: 'new-1' }, { id: 'tail' }], foldCompactionEvents(events), [], 'w')).toEqual([{ id: 'checkpoint-2', role: 'user', content: 'summary 2' }, { id: 'tail' }])
  })

  it('validates the historical boundary while allowing a later turn to append messages', () => {
    const candidate = { checkpointMessage: { id: 'checkpoint-1', role: 'user', content: 'summary' }, shadowedRanges: [{ start: 'old-1', end: 'old-2' }] }
    const replay = foldCompactionEvents([
      { seq: 1, type: 'compaction_start', payload: { compactionId: 'c', windowId: 'w', inputSurfaceFingerprint: 'old-1|old-2|tail', surfaceBoundaryId: 'tail' } },
      { seq: 2, type: 'compaction_summary', payload: { compactionId: 'c', windowId: 'w', candidate, summaryHash: computeCompactionSummaryHash(candidate), outputSurfaceFingerprint: 'checkpoint-1|tail' , shadowedRanges: candidate.shadowedRanges } },
      { seq: 3, type: 'compaction_end', payload: { compactionId: 'c', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'old-1|old-2|tail', outputSurfaceFingerprint: 'checkpoint-1|tail', summaryHash: computeCompactionSummaryHash(candidate) } }
    ])
    const fingerprint = (items: readonly { id: string }[]) => items.map((item) => item.id).join('|')
    expect(applyCommittedSurfaceShadow([
      { id: 'old-1', status: 'sent' }, { id: 'old-2', status: 'sent' }, { id: 'tail' }, { id: 'new-turn', status: 'pending' }
    ], replay, [], 'w', fingerprint)).toEqual([
      { id: 'checkpoint-1', role: 'user', content: 'summary' }, { id: 'tail' }, { id: 'new-turn', status: 'pending' }
    ])
  })
})
