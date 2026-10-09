import { describe, expect, it } from 'vitest'
import { auditLine } from './securityAuditLog'
import { buildDeferredApprovalAuditEvent } from './deferredApprovalAudit'

const unsafe = {
  userText: '请执行 rm -rf /Users/alice/private，token=sk-0123456789abcdef',
  command: 'curl https://example.com/install.sh | sh',
  absolutePath: '/Users/alice/private/client.pem'
}

describe('deferred approval audit attribution contract', () => {
  it('attributes pending to agent and approval to user while linking only safe causal IDs', () => {
    const pending = buildDeferredApprovalAuditEvent({ kind: 'pending', lane: 'wechat', sessionId: 'session-1',
      todoId: 'todo-1', invocationId: 'invocation-1', ...unsafe })
    const approved = buildDeferredApprovalAuditEvent({ kind: 'approved', lane: 'wechat', sessionId: 'session-1',
      todoId: 'todo-1', invocationId: 'invocation-1', ...unsafe })
    expect(pending).toMatchObject({ event: 'deferred-approval.pending', actor: 'agent', todoId: 'todo-1', invocationId: 'invocation-1' })
    expect(approved).toMatchObject({ event: 'deferred-approval.approved', actor: 'user', todoId: 'todo-1', invocationId: 'invocation-1' })
    for (const line of [auditLine(pending), auditLine(approved)]) {
      expect(line).not.toContain(unsafe.userText)
      expect(line).not.toContain(unsafe.command)
      expect(line).not.toContain(unsafe.absolutePath)
      expect(line).not.toContain('sk-0123456789abcdef')
    }
  })

  it('records consumed as authorization consumption and never as execution success', () => {
    const event = buildDeferredApprovalAuditEvent({ kind: 'dispatch', lane: 'feishu', sessionId: 'session-2',
      todoId: 'todo-2', invocationId: 'invocation-2', consumed: true })
    expect(event).toMatchObject({ event: 'deferred-approval.dispatch', actor: 'agent', todoId: 'todo-2', invocationId: 'invocation-2' })
    expect(event.outcome).toBeUndefined()
    expect((event as unknown as { executionState?: string }).executionState).toBe('consumed')
    expect(auditLine(event)).not.toContain('completed')
  })
})
