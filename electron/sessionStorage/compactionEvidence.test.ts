import { describe, expect, it } from 'vitest'
import { classifyCompactionRecoveryEvidence } from './compactionEvidence'

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
