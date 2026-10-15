import { describe, expect, it } from 'vitest'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { recordPolicyExecutionVeto } from './audit'
import { auditFactId } from './auditFactId'

describe('policy.execution-veto audit', () => {
  it('records binding and failure facts without target path', () => {
    const events: SecurityAuditEvent[] = []
    recordPolicyExecutionVeto({ audit: { record: (event) => events.push(event) }, lane: 'desktop', sessionId: 's', requestId: 'r', toolUseId: 't', decisionId: 'decision-1', toolName: 'read_file', decisionRuleId: 'read-allow', pathZone: 'outside-workdir', factId: 'fact-/private/user/secret.txt', failureClass: 'mechanism', caseId: 'read-target-identity-changed', invariantId: 'SYS-PERMIT-001' })
    expect(events[0]).toMatchObject({ event: 'policy.execution-veto', requestId: 'r', toolUseId: 't', decisionId: 'decision-1', priorDecision: 'available', toolName: 'read_file', decisionRuleId: 'read-allow', pathZone: 'outside-workdir', factId: auditFactId('fact-/private/user/secret.txt'), failureClass: 'mechanism', caseId: 'read-target-identity-changed', invariantId: 'SYS-PERMIT-001' })
    expect(JSON.stringify(events)).not.toContain('/private/user/secret.txt')
  })

  it('records when a veto has no originating policy decision', () => {
    const events: SecurityAuditEvent[] = []
    recordPolicyExecutionVeto({ audit: { record: (event) => events.push(event) }, lane: 'desktop', sessionId: 's', toolName: 'read_file', failureClass: 'integration-violation', caseId: 'permit-missing' })
    expect(events[0]).toMatchObject({ event: 'policy.execution-veto', priorDecision: 'unavailable', failureClass: 'integration-violation' })
    expect(events[0]?.event).not.toBe('policy.deny')
  })
})
