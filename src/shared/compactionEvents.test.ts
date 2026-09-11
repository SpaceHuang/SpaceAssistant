import { describe, expect, it } from 'vitest'
import { computeCompactionSummaryHash, countCommittedCompactions, foldCompactionEvents, projectCompactionMarkers } from './compactionEvents'

const event = (seq: number, type: 'compaction_start' | 'compaction_summary' | 'compaction_end', payload: Record<string, unknown>) => ({ seq, type, payload })

describe('compaction event replay', () => {
  it('hashes equivalent candidate objects deterministically', () => {
    expect(computeCompactionSummaryHash({ b: 2, a: { y: 1, x: 0 } })).toBe(computeCompactionSummaryHash({ a: { x: 0, y: 1 }, b: 2 }))
  })
  it('hashes nullish candidates without throwing', () => {
    expect(computeCompactionSummaryHash(undefined)).toMatch(/^[0-9a-f]{8}$/)
    expect(computeCompactionSummaryHash(null)).toMatch(/^[0-9a-f]{8}$/)
  })
  it('applies only a complete committed triplet', () => {
    const result = foldCompactionEvents([
      event(1, 'compaction_start', { compactionId: 'c1', inputSurfaceFingerprint: 'in', targetTokens: 10 }),
      event(2, 'compaction_summary', { compactionId: 'c1', summaryHash: computeCompactionSummaryHash({ text: 'summary' }), outputSurfaceFingerprint: 'out', candidate: { text: 'summary' } }),
      event(3, 'compaction_end', { compactionId: 'c1', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: computeCompactionSummaryHash({ text: 'summary' }) })
    ])
    expect(result.committed).toHaveLength(1)
    expect(result.committed[0]?.compactionId).toBe('c1')
  })

  it('ignores torn, out-of-order, conflicting, and duplicate commits', () => {
    const base = [
      event(1, 'compaction_start', { compactionId: 'c1', inputSurfaceFingerprint: 'in', targetTokens: 10 }),
      event(2, 'compaction_summary', { compactionId: 'c1', summaryHash: computeCompactionSummaryHash({}), outputSurfaceFingerprint: 'out', candidate: {} }),
      event(3, 'compaction_end', { compactionId: 'c1', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: computeCompactionSummaryHash({}) })
    ]
    const result = foldCompactionEvents([...base, base[2]!, event(5, 'compaction_end', { compactionId: 'unknown', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: 'h1' })])
    expect(result.committed).toHaveLength(1)
    expect(result.rejected.length).toBe(2)
  })

  it('counts only committed summaries within the current window', () => {
    const replay = foldCompactionEvents([
      event(1, 'compaction_start', { compactionId: 'c1', windowId: 'w1', inputSurfaceFingerprint: 'a' }),
      event(2, 'compaction_summary', { compactionId: 'c1', windowId: 'w1', summaryHash: 'h', outputSurfaceFingerprint: 'b' }),
      event(3, 'compaction_end', { compactionId: 'c1', windowId: 'w1', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'a', outputSurfaceFingerprint: 'b', summaryHash: 'h' }),
      event(4, 'compaction_start', { compactionId: 'c2', windowId: 'w2', inputSurfaceFingerprint: 'c' }),
      event(5, 'compaction_summary', { compactionId: 'c2', windowId: 'w2', summaryHash: 'i', outputSurfaceFingerprint: 'd' }),
      event(6, 'compaction_end', { compactionId: 'c2', windowId: 'w2', status: 'committed', startSeq: 4, summarySeq: 5, inputSurfaceFingerprint: 'c', outputSurfaceFingerprint: 'd', summaryHash: 'i' })
    ])
    expect(countCommittedCompactions(replay, 'w1')).toBe(1)
    expect(countCommittedCompactions(replay, 'w3')).toBe(0)
  })

  it('projects only committed replay records into UI markers', () => {
    const replay = foldCompactionEvents([
      event(1, 'compaction_start', { compactionId: 'c1', windowId: 'w1', inputSurfaceFingerprint: 'a' }),
      event(2, 'compaction_summary', { compactionId: 'c1', windowId: 'w1', summaryHash: 'h', outputSurfaceFingerprint: 'b' }),
      event(3, 'compaction_end', { compactionId: 'c1', windowId: 'w1', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'a', outputSurfaceFingerprint: 'b', summaryHash: 'h' })
    ])
    expect(projectCompactionMarkers(replay, 'w1')).toEqual([{ compactionId: 'c1', windowId: 'w1', outputSurfaceFingerprint: 'b' }])
    expect(projectCompactionMarkers(replay, 'w2')).toEqual([])
  })

  it('rejects a transaction whose window identity changes mid-commit', () => {
    const result = foldCompactionEvents([
      event(1, 'compaction_start', { compactionId: 'cross', windowId: 'w1', inputSurfaceFingerprint: 'a' }),
      event(2, 'compaction_summary', { compactionId: 'cross', windowId: 'w2', summaryHash: 'h', outputSurfaceFingerprint: 'b' }),
      event(3, 'compaction_end', { compactionId: 'cross', windowId: 'w2', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'a', outputSurfaceFingerprint: 'b', summaryHash: 'h' })
    ])
    expect(result.committed).toHaveLength(0)
    expect(result.rejected).toContainEqual({ compactionId: 'cross', reason: 'invalid-commit-references' })
  })

  it('rejects committed records with malformed shadow ranges', () => {
    const result = foldCompactionEvents([
      event(1, 'compaction_start', { compactionId: 'bad-range', windowId: 'w', inputSurfaceFingerprint: 'a' }),
      event(2, 'compaction_summary', { compactionId: 'bad-range', windowId: 'w', summaryHash: 'h', outputSurfaceFingerprint: 'b', shadowedRanges: [{ start: 'only' }, 'bad'] }),
      event(3, 'compaction_end', { compactionId: 'bad-range', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'a', outputSurfaceFingerprint: 'b', summaryHash: 'h' })
    ])
    expect(result.committed).toHaveLength(0)
  })

  it('rejects a candidate whose canonical hash does not match summaryHash', () => {
    const result = foldCompactionEvents([
      event(1, 'compaction_start', { compactionId: 'bad-hash', windowId: 'w', inputSurfaceFingerprint: 'a' }),
      event(2, 'compaction_summary', { compactionId: 'bad-hash', windowId: 'w', summaryHash: 'wrong', outputSurfaceFingerprint: 'b', candidate: { text: 'candidate' } }),
      event(3, 'compaction_end', { compactionId: 'bad-hash', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'a', outputSurfaceFingerprint: 'b', summaryHash: 'wrong' })
    ])
    expect(result.committed).toHaveLength(0)
  })
})
