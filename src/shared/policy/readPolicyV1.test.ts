import { describe, expect, it } from 'vitest'
import { validateDesktopReadV1 } from './readPolicyV1'
import type { ContentFacts } from '../confirmation/types'
const facts: ContentFacts = { toolName: 'read_file', actionClass: 'read', baseRiskLevel: 'low', signals: [], summary: { text: 'read' } }
const context = { lane: 'desktop' as const, sessionId: 's' }
describe('desktop read V1 target validation', () => {
  it.each(['workdir-normal', 'outside-workdir', 'sensitive-file', 'system-dir'] as const)('accepts valid target facts for zone %s without deciding policy', (zone) => {
    expect(validateDesktopReadV1({ facts, context, zone, targetKind: 'file', hasExplicitPath: true })).toBeUndefined()
  })
  it.each(['directory', 'special', 'unknown'] as const)('fails closed for target kind %s', (targetKind) => {
    expect(validateDesktopReadV1({ facts, context, zone: 'workdir-normal', targetKind, hasExplicitPath: true })).toMatchObject({ type: 'deny', ruleId: 'read-v1-target-unsupported' })
  })
  it('rejects missing paths and wildcard patterns', () => {
    expect(validateDesktopReadV1({ facts, context, hasExplicitPath: false })).toMatchObject({ type: 'deny', ruleId: 'read-v1-facts-missing' })
    expect(validateDesktopReadV1({ facts, context, zone: 'workdir-normal', targetKind: 'file', hasExplicitPath: true, hasUnsupportedPattern: true })).toMatchObject({ type: 'deny', ruleId: 'read-v1-target-unsupported' })
  })
})
