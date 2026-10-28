/** Evidence classification for legacy compaction recovery. This describes facts only; callers choose user-visible recovery behavior. */
export type CompactionRecoveryEvidence = Readonly<{
  checkpointAvailable: boolean
  positiveCompactionEvidence: boolean
  completeDualSourceCoverage: boolean
  replayMetadataComplete: boolean
  estimatedTokens: number
  tokenBudget: number
}>

export type CompactionRecoveryClassification = Readonly<{
  classification: 'checkpoint-available' | 'window-lost-replayable' | 'window-lost-unreplayable' | 'compaction-unknown' | 'never-compressed'
  action: 'use-checkpoint' | 'replay-original' | 'new-split' | 'full-expand'
  budget: 'within-budget' | 'over-budget'
  overBudgetExit?: 'show-context-too-large'
}>

export function classifyCompactionRecoveryEvidence(evidence: CompactionRecoveryEvidence): CompactionRecoveryClassification {
  if (!Number.isSafeInteger(evidence.estimatedTokens) || evidence.estimatedTokens < 0 ||
    !Number.isSafeInteger(evidence.tokenBudget) || evidence.tokenBudget < 0) {
    throw new Error('COMPACTION_RECOVERY_BUDGET_INVALID')
  }
  let classification: CompactionRecoveryClassification['classification']
  let action: CompactionRecoveryClassification['action']
  if (evidence.checkpointAvailable) {
    classification = 'checkpoint-available'
    action = 'use-checkpoint'
  } else if (evidence.positiveCompactionEvidence) {
    if (evidence.replayMetadataComplete) {
      classification = 'window-lost-replayable'
      action = 'replay-original'
    } else {
      classification = 'window-lost-unreplayable'
      action = 'new-split'
    }
  } else if (evidence.completeDualSourceCoverage) {
    classification = 'never-compressed'
    action = 'full-expand'
  } else {
    classification = 'compaction-unknown'
    action = 'full-expand'
  }
  const overBudget = evidence.estimatedTokens > evidence.tokenBudget
  return Object.freeze({ classification, action, budget: overBudget ? 'over-budget' : 'within-budget',
    ...(overBudget ? { overBudgetExit: 'show-context-too-large' as const } : {}) })
}
