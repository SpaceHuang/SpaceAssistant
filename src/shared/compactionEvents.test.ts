import { describe, expect, it } from 'vitest'
import { foldCompactionEvents } from './compactionEvents'

const event = (seq: number, type: 'compaction_start' | 'compaction_summary' | 'compaction_end', payload: Record<string, unknown>) => ({ seq, type, payload })

describe('compaction event replay', () => {
  it('applies only a complete committed triplet', () => {
    const result = foldCompactionEvents([
      event(1, 'compaction_start', { compactionId: 'c1', inputSurfaceFingerprint: 'in', targetTokens: 10 }),
      event(2, 'compaction_summary', { compactionId: 'c1', summaryHash: 'h1', outputSurfaceFingerprint: 'out', candidate: { text: 'summary' } }),
      event(3, 'compaction_end', { compactionId: 'c1', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: 'h1' })
    ])
    expect(result.committed).toHaveLength(1)
    expect(result.committed[0]?.compactionId).toBe('c1')
  })

  it('ignores torn, out-of-order, conflicting, and duplicate commits', () => {
    const base = [
      event(1, 'compaction_start', { compactionId: 'c1', inputSurfaceFingerprint: 'in', targetTokens: 10 }),
      event(2, 'compaction_summary', { compactionId: 'c1', summaryHash: 'h1', outputSurfaceFingerprint: 'out', candidate: {} }),
      event(3, 'compaction_end', { compactionId: 'c1', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: 'h1' })
    ]
    const result = foldCompactionEvents([...base, base[2]!, event(5, 'compaction_end', { compactionId: 'unknown', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: 'h1' })])
    expect(result.committed).toHaveLength(1)
    expect(result.rejected.length).toBe(2)
  })
})
