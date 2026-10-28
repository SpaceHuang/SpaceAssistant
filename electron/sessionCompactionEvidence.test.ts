import { describe, expect, it } from 'vitest'
import { classifyCompactionRecoveryEvidence, inspectLostCompactionRepairEvidence, isCompactionRepairSourceRevisionCurrent } from './sessionCompactionEvidence'

const evidence = (patch: Partial<Parameters<typeof classifyCompactionRecoveryEvidence>[0]> = {}) => ({
  checkpointAvailable: false,
  positiveCompactionEvidence: false,
  completeDualSourceCoverage: false,
  replayMetadataComplete: false,
  estimatedTokens: 100,
  tokenBudget: 1_000,
  ...patch
})

describe('classifyCompactionRecoveryEvidence', () => {
  it.each([
    [evidence({ checkpointAvailable: true }), 'checkpoint-available', 'use-checkpoint'],
    [evidence({ positiveCompactionEvidence: true, replayMetadataComplete: true }), 'window-lost-replayable', 'replay-original'],
    [evidence({ positiveCompactionEvidence: true }), 'window-lost-unreplayable', 'new-split'],
    [evidence({ completeDualSourceCoverage: true }), 'never-compressed', 'full-expand'],
    [evidence(), 'compaction-unknown', 'full-expand']
  ] as const)('selects one exclusive classification and action', (input, classification, action) => {
    expect(classifyCompactionRecoveryEvidence(input)).toMatchObject({ classification, action, budget: 'within-budget' })
  })

  it('does not treat missing evidence as proof of never compressed', () => {
    expect(classifyCompactionRecoveryEvidence(evidence({ completeDualSourceCoverage: false })).classification).toBe('compaction-unknown')
  })

  it('defines an explicit over-budget exit for full expansion', () => {
    expect(classifyCompactionRecoveryEvidence(evidence({ estimatedTokens: 1_001 })).overBudgetExit).toBe('show-context-too-large')
  })

  it('rejects invalid budget measurements', () => {
    expect(() => classifyCompactionRecoveryEvidence(evidence({ estimatedTokens: -1 }))).toThrow('COMPACTION_RECOVERY_BUDGET_INVALID')
  })
})

describe('inspectLostCompactionRepairEvidence', () => {
  it('returns original verified window metadata from a committed replay when the checkpoint is absent', () => {
    const replay = { committed: [{ compactionId: 'old-compact',
      start: { seq: 1, type: 'compaction_start' as const, payload: { compactionId: 'old-compact', inputSurfaceFingerprint: 'before' } },
      summary: { seq: 2, type: 'compaction_summary' as const, payload: { compactionId: 'old-compact', shadowedRanges: [{ start: 'm1', end: 'm4' }], candidate: { kind: 'summary' } } },
      end: { seq: 3, type: 'compaction_end' as const, payload: { compactionId: 'old-compact', status: 'committed' } } }], rejected: [] }
    expect(inspectLostCompactionRepairEvidence({ replay, messages: [{ id: 'm1', content: 'first' }, { id: 'm4', content: 'last' }] }))
      .toMatchObject({ action: 'replay-original', sourceVersion: expect.any(String), lostWindow: { start: 'm1', end: 'm4' } })
  })

  it('validates range endpoints against replay surface identities rather than source message ids', () => {
    const replay = { committed: [{ compactionId: 'surface-window',
      start: { seq: 1, type: 'compaction_start' as const, payload: { compactionId: 'surface-window', inputSurfaceFingerprint: 'before' } },
      summary: { seq: 2, type: 'compaction_summary' as const, payload: { compactionId: 'surface-window', shadowedRanges: [{ start: 'surface-a', end: 'surface-b' }], candidate: { kind: 'summary' } } },
      end: { seq: 3, type: 'compaction_end' as const, payload: { compactionId: 'surface-window', status: 'committed' } } }], rejected: [] }
    expect(inspectLostCompactionRepairEvidence({ replay,
      messages: [{ id: 'db-a', content: 'first' }, { id: 'db-b', content: 'last' }],
      surfaceIdentities: ['surface-a', 'surface-b'] }))
      .toMatchObject({ classification: 'window-lost-replayable', action: 'replay-original', lostWindow: { start: 'surface-a', end: 'surface-b' } })
  })

  it('never invents a repair when the only evidence is incomplete or absent', () => {
    expect(inspectLostCompactionRepairEvidence({ replay: { committed: [], rejected: [] }, messages: [{ id: 'm1', content: 'body' }] }))
      .toMatchObject({ action: 'full-expand', classification: 'compaction-unknown' })
  })

  it('selects new-split only when compression is positively recorded but its original range is unavailable', () => {
    const replay = { committed: [{ compactionId: 'known-compressed',
      start: { seq: 1, type: 'compaction_start' as const, payload: { compactionId: 'known-compressed' } },
      summary: { seq: 2, type: 'compaction_summary' as const, payload: { compactionId: 'known-compressed', candidate: { kind: 'summary' } } },
      end: { seq: 3, type: 'compaction_end' as const, payload: { compactionId: 'known-compressed', status: 'committed' } } }], rejected: [] }
    expect(inspectLostCompactionRepairEvidence({ replay, messages: [{ id: 'current', content: 'history' }] }))
      .toMatchObject({ action: 'new-split', classification: 'window-lost-unreplayable', branch: 'new-split' })
  })

  it('downgrades overlapping or out-of-order source ranges to new-split', () => {
    const ranges = [{ start: 'm1', end: 'm4' }, { start: 'm4', end: 'm8' }]
    const replay = { committed: [{ compactionId: 'overlapping-window',
      start: { seq: 1, type: 'compaction_start' as const, payload: { compactionId: 'overlapping-window', inputSurfaceFingerprint: 'before' } },
      summary: { seq: 2, type: 'compaction_summary' as const, payload: { compactionId: 'overlapping-window', shadowedRanges: ranges, candidate: { kind: 'summary' } } },
      end: { seq: 3, type: 'compaction_end' as const, payload: { compactionId: 'overlapping-window', status: 'committed' } } }], rejected: [] }
    const messages = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'].map((id) => ({ id, content: id }))
    expect(inspectLostCompactionRepairEvidence({ replay, messages }))
      .toMatchObject({ classification: 'window-lost-unreplayable', action: 'new-split', branch: 'new-split' })
  })

  it('uses an available checkpoint instead of creating another repair', () => {
    const result = inspectLostCompactionRepairEvidence({ replay: { committed: [], rejected: [] },
      messages: [{ id: 'checkpoint', content: JSON.stringify({ kind: 'context_checkpoint', task: 'known' }) }] })
    expect(result).toMatchObject({ action: 'use-checkpoint', classification: 'checkpoint-available' })
    expect(result.branch).toBeUndefined()
  })

  it('computes the same source version regardless of object key insertion order', () => {
    const replay = { committed: [], rejected: [] }
    const a = inspectLostCompactionRepairEvidence({ replay, messages: [{ id: 'm1', content: { alpha: 1, beta: 2 } }] })
    const b = inspectLostCompactionRepairEvidence({ replay, messages: [{ content: { beta: 2, alpha: 1 }, id: 'm1' }] })
    expect(a.sourceVersion).toBe(b.sourceVersion)
  })

  it('does not reuse an old repair identity when a checkpoint is available for current messages', () => {
    const replay = { committed: [{ compactionId: 'repair-id',
      start: { seq: 1, type: 'compaction_start' as const, payload: { compactionId: 'repair-id', sourceRequestId: 'original-repair-request', repairIdentity: {
        sourceVersion: 'source-v', branch: 'new-split', windowStart: 'lost-window', windowEnd: 'lost-window', ranges: []
      } } },
      summary: { seq: 2, type: 'compaction_summary' as const, payload: { compactionId: 'repair-id' } },
      end: { seq: 3, type: 'compaction_end' as const, payload: { compactionId: 'repair-id', status: 'committed' } } }], rejected: [] }
    const result = inspectLostCompactionRepairEvidence({ replay, requestId: 'manual-request', messages: [
      { id: 'checkpoint', content: '{"kind":"context_checkpoint"}' },
      { id: 'new-user', content: 'new request' }, { id: 'new-assistant', content: 'new answer' }
    ] })
    expect(result).toMatchObject({ classification: 'checkpoint-available', action: 'use-checkpoint' })
    expect(result.branch).toBeUndefined()
  })
})

describe('isCompactionRepairSourceRevisionCurrent', () => {
  it('accepts only the same session incarnation and message revision', () => {
    const before = { sessionId: 's1', generation: 'generation-1', messageRevision: 7 }
    expect(isCompactionRepairSourceRevisionCurrent(before, { ...before })).toBe(true)
    expect(isCompactionRepairSourceRevisionCurrent(before, { ...before, messageRevision: 8 })).toBe(false)
    expect(isCompactionRepairSourceRevisionCurrent(before, { ...before, generation: 'generation-2' })).toBe(false)
    expect(isCompactionRepairSourceRevisionCurrent(before, undefined)).toBe(false)
  })
})
