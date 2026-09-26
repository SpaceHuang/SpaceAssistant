import { describe, expect, it } from 'vitest'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { recordPolicyExecutionVeto } from './audit'
import { auditFactId } from './auditFactId'

describe('policy.execution-veto audit', () => {
  it('records binding and failure facts without target path', () => {
    const events: SecurityAuditEvent[] = []
    recordPolicyExecutionVeto({ audit: { record: (event) => events.push(event) }, lane: 'desktop', sessionId: 's', requestId: 'r', toolUseId: 't', toolName: 'read_file', decisionRuleId: 'read-allow', pathZone: 'outside-workdir', factId: 'fact-/private/user/secret.txt', failureClass: 'mechanism', caseId: 'read-target-identity-changed' })
    expect(events[0]).toMatchObject({ event: 'policy.execution-veto', requestId: 'r', toolUseId: 't', toolName: 'read_file', decisionRuleId: 'read-allow', pathZone: 'outside-workdir', factId: auditFactId('fact-/private/user/secret.txt'), failureClass: 'mechanism', caseId: 'read-target-identity-changed' })
    expect(JSON.stringify(events)).not.toContain('/private/user/secret.txt')
  })
})
