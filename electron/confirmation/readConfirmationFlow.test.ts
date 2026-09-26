import { describe, expect, it } from 'vitest'
import { readConfirmationRegistry, ReadConfirmationRegistry } from './readConfirmationRegistry'
import { readInputDigest } from './readExecutionPermit'
import { finalizeReadConfirmation, settleReadConfirmation } from './readConfirmationFlow'

const fact = { rawPath: '/tmp/a', normalizedPath: '/tmp/a', zone: 'sensitive-file' as const, targetKind: 'file' as const, identity: { dev: 1, ino: 2, mode: 33188, size: 1, mtimeMs: 1 }, scope: 'single-target' as const }

describe('read confirmation production flow', () => {
  it('只在 gate pending 登记后真人批准时生成一次性 permit', () => {
    const registry = new ReadConfirmationRegistry({ now: () => 10 })
    const input = { path: '/tmp/a' }
    registry.register({ requestId: 'r', toolUseId: 't', inputDigest: readInputDigest(input), factIds: ['fact-/tmp/a'], ruleId: 'sensitive-rule', expiresAt: 100 })
    const approvedTargets = [{ factId: 'fact-/tmp/a', decisionRuleId: 'sensitive-rule' }]
    const permit = finalizeReadConfirmation({ toolName: 'read_file', toolInput: input, requestId: 'r', toolUseId: 't', outcome: 'approved', answerer: 'user', readPathFact: fact, approvedTargets }, registry)
    expect(permit?.targets[0]?.factId).toBe('fact-/tmp/a')
    expect(finalizeReadConfirmation({ toolName: 'read_file', toolInput: input, requestId: 'r', toolUseId: 't', outcome: 'approved', answerer: 'user', readPathFact: fact, approvedTargets }, registry)).toBeUndefined()
  })
  it('拒绝输入变化、取消、非用户批准和无 pending 登记', () => {
    const registry = new ReadConfirmationRegistry({ now: () => 10 })
    const input = { path: '/tmp/a' }
    registry.register({ requestId: 'r', toolUseId: 't', inputDigest: readInputDigest(input), factIds: ['fact-/tmp/a'], ruleId: 'sensitive-rule', expiresAt: 100 })
    const approvedTargets = [{ factId: 'fact-/tmp/a', decisionRuleId: 'sensitive-rule' }]
    expect(finalizeReadConfirmation({ toolName: 'read_file', toolInput: { path: '/tmp/b' }, requestId: 'r', toolUseId: 't', outcome: 'approved', answerer: 'user', readPathFact: fact, approvedTargets }, registry)).toBeUndefined()
    expect(finalizeReadConfirmation({ toolName: 'read_file', toolInput: input, requestId: 'r', toolUseId: 't', outcome: 'rejected', answerer: 'user', readPathFact: fact, approvedTargets }, registry)).toBeUndefined()
    expect(finalizeReadConfirmation({ toolName: 'read_file', toolInput: input, requestId: 'r', toolUseId: 't', outcome: 'approved', answerer: 'agent', readPathFact: fact, approvedTargets }, registry)).toBeUndefined()
  })
  it('rejection and timeout settle pending registrations before any late approval', () => {
    const rejected = new ReadConfirmationRegistry({ now: () => 10 })
    rejected.register({ requestId: 'r-reject', toolUseId: 't-reject', inputDigest: 'd', factIds: ['f'], ruleId: 'rule', expiresAt: 100 })
    settleReadConfirmation({ toolName: 'read_file', requestId: 'r-reject', toolUseId: 't-reject', outcome: 'rejected' }, rejected)
    expect(rejected.approve({ requestId: 'r-reject', toolUseId: 't-reject', inputDigest: 'd', approvedFactIds: ['f'] })).toBe(false)

    const timedOut = new ReadConfirmationRegistry({ now: () => 10 })
    timedOut.register({ requestId: 'r-timeout', toolUseId: 't-timeout', inputDigest: 'd', factIds: ['f'], ruleId: 'rule', expiresAt: 100 })
    settleReadConfirmation({ toolName: 'grep', requestId: 'r-timeout', toolUseId: 't-timeout', outcome: 'timeout' }, timedOut)
    expect(timedOut.approve({ requestId: 'r-timeout', toolUseId: 't-timeout', inputDigest: 'd', approvedFactIds: ['f'] })).toBe(false)
  })
  it('gate 目标规则不匹配时拒绝且保留 pending 登记', () => {
    const registry = new ReadConfirmationRegistry({ now: () => 10 })
    const input = { path: '/tmp/a' }
    registry.register({ requestId: 'r', toolUseId: 't', inputDigest: readInputDigest(input), factIds: ['fact-/tmp/a'], ruleId: 'sensitive-rule', expiresAt: 100 })
    expect(finalizeReadConfirmation({ toolName: 'read_file', toolInput: input, requestId: 'r', toolUseId: 't', outcome: 'approved', answerer: 'user', readPathFact: fact, approvedTargets: [{ factId: 'fact-/tmp/a', decisionRuleId: 'other-rule' }] }, registry)).toBeUndefined()
    const permit = finalizeReadConfirmation({ toolName: 'read_file', toolInput: input, requestId: 'r', toolUseId: 't', outcome: 'approved', answerer: 'user', readPathFact: fact, approvedTargets: [{ factId: 'fact-/tmp/a', decisionRuleId: 'sensitive-rule' }] }, registry)
    expect(permit?.targets[0]?.decisionRuleId).toBe('sensitive-rule')
  })

  it('飞书附件 user 确认后生成带目标 identity 的一次性 permit', () => {
    const registry = new ReadConfirmationRegistry({ now: () => 10 })
    const toolInput = { attachmentId: 'attachment-1' }
    const normalizedPath = '/tmp/user/feishu-media/cache/a.txt'
    const factId = `fact-${normalizedPath}`
    const identity = { dev: 1, ino: 2, mode: 33188, size: 10, mtimeMs: 10 }
    registry.register({ requestId: 'feishu-r', toolUseId: 'feishu-t', inputDigest: readInputDigest(toolInput), factIds: [factId], ruleId: 'feishu-user-confirm', expiresAt: 100 })
    const permit = finalizeReadConfirmation({
      toolName: 'read_feishu_attachment',
      toolInput,
      requestId: 'feishu-r',
      toolUseId: 'feishu-t',
      outcome: 'approved',
      answerer: 'user',
      feishuMediaFact: { boundary: 'inside', normalizedPath, targetKind: 'file', identity },
      approvedTargets: [{ factId, decisionRuleId: 'feishu-user-confirm' }]
    }, registry)
    expect(permit).toMatchObject({ toolName: 'read_feishu_attachment', targets: [{ normalizedPath, identity }] })
    expect(finalizeReadConfirmation({
      toolName: 'read_feishu_attachment', toolInput, requestId: 'feishu-r', toolUseId: 'feishu-t', outcome: 'approved', answerer: 'user',
      feishuMediaFact: { boundary: 'inside', normalizedPath, targetKind: 'file', identity }, approvedTargets: [{ factId, decisionRuleId: 'feishu-user-confirm' }]
    }, registry)).toBeUndefined()
  })
})
