import { describe, expect, it } from 'vitest'
import { applyCommittedSurfaceShadow, computeShadowedRanges } from './surfaceReplay'
import { foldCompactionEvents } from './compactionEvents'

describe('surface replay', () => {
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
})
