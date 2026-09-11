import { describe, expect, it } from 'vitest'
import { applyCommittedSurfaceShadow } from './surfaceReplay'
import { foldCompactionEvents } from './compactionEvents'

describe('surface replay', () => {
  it('hides committed shadow ranges without deleting facts or required input', () => {
    const replay = foldCompactionEvents([
      { seq: 1, type: 'compaction_start', payload: { compactionId: 'c', windowId: 'w', inputSurfaceFingerprint: 'in' } },
      { seq: 2, type: 'compaction_summary', payload: { compactionId: 'c', windowId: 'w', summaryHash: 'h', outputSurfaceFingerprint: 'out', shadowedRanges: [{ start: 'old-1', end: 'old-2' }] } },
      { seq: 3, type: 'compaction_end', payload: { compactionId: 'c', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: 'h' } }
    ])
    const facts = [{ id: 'old-1' }, { id: 'old-2' }, { id: 'current', required: true }, { id: 'tail' }]
    expect(applyCommittedSurfaceShadow(facts, replay, ['old-2'])).toEqual([{ id: 'old-2' }, { id: 'current', required: true }, { id: 'tail' }])
    expect(facts).toHaveLength(4)
  })
})
