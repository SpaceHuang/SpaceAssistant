import { describe, expect, it } from 'vitest'
import { validateSurfaceForSend } from './surfacePreflight'

describe('surface send preflight', () => {
  it('requires every required id exactly once and validates fingerprint/budget', () => {
    const base = { ids: ['current', 'tool-result'], requiredIds: ['current', 'tool-result'], currentUserMessageId: 'current', fingerprint: 'f', expectedFingerprint: 'f', estimatedTotalInputTokens: 90, totalInputBudget: 100, toolUses: ['tool-1'], toolResults: ['tool-1'] }
    expect(validateSurfaceForSend(base)).toMatchObject({ ok: true, tokenCheckSource: 'default_estimator' })
    expect(validateSurfaceForSend({ ...base, ids: ['current', 'current'] }).reason).toBe('required_ids_invalid')
    expect(validateSurfaceForSend({ ...base, fingerprint: 'changed' }).reason).toBe('fingerprint_mismatch')
  })
  it('rejects incomplete tool pairs and hard overflow', () => {
    const base = { ids: ['current'], requiredIds: ['current'], currentUserMessageId: 'current', fingerprint: 'f', expectedFingerprint: 'f', estimatedTotalInputTokens: 101, totalInputBudget: 100, toolUses: ['tool-1'], toolResults: [] }
    expect(validateSurfaceForSend(base).reason).toBe('tool_pair_invalid')
    expect(validateSurfaceForSend({ ...base, toolResults: ['tool-1'] }).reason).toBe('token_budget_exceeded')
  })
})
