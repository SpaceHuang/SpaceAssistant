import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readConfirmationRegistry, ReadConfirmationRegistry } from './readConfirmationRegistry'
import { readInputDigest } from './readExecutionPermit'
import { finalizeAgentReadReview, finalizeReadConfirmation, settleReadConfirmation } from './readConfirmationFlow'
import { resolveReadPermitTarget } from './readPermitExecutor'

const fact = { rawPath: '/tmp/a', normalizedPath: '/tmp/a', zone: 'sensitive-file' as const, targetKind: 'file' as const, identity: { dev: 1, ino: 2, mode: 33188, size: 1, mtimeMs: 1 }, scope: 'single-target' as const }

describe('read confirmation production flow', () => {
  it('agent approval yields only a call-bound permit for an outside ordinary single file', () => {
    const outsideFact = { ...fact, zone: 'outside-workdir' as const }
    const permit = finalizeAgentReadReview({
      toolName: 'read_file', toolInput: { path: '/tmp/a' }, requestId: 'agent-r', toolUseId: 'agent-t',
      outcome: 'approved', answerer: 'agent', readPathFact: outsideFact,
      approvedTargets: [{ factId: 'fact-/tmp/a', decisionRuleId: 'im-outside-read-review' }],
      decisionId: 'decision-1', policyDependencyFingerprint: 'sha256:policy-1'
    })
    expect(permit).toMatchObject({ requestId: 'agent-r', toolUseId: 'agent-t', toolName: 'read_file', decisionId: 'decision-1',
      policyDependencyFingerprint: 'sha256:policy-1', targets: [{ normalizedPath: '/tmp/a', zone: 'outside-workdir', identity: outsideFact.identity }] })
    expect(finalizeAgentReadReview({
      toolName: 'read_file', toolInput: { path: '/tmp/b' }, requestId: 'agent-r', toolUseId: 'agent-t',
      outcome: 'approved', answerer: 'agent', readPathFact: outsideFact,
      approvedTargets: [{ factId: 'fact-/tmp/a', decisionRuleId: 'im-outside-read-review' }]
    })).toBeUndefined()
    expect(finalizeAgentReadReview({
      toolName: 'grep', toolInput: { path: '/tmp/a', pattern: 'x' }, requestId: 'agent-r', toolUseId: 'agent-t',
      outcome: 'approved', answerer: 'agent', readPathFact: { ...outsideFact, targetKind: 'directory', resolvedKind: 'directory' },
      approvedTargets: [{ factId: 'fact-/tmp/a', decisionRuleId: 'im-outside-read-review' }]
    })).toBeUndefined()
  })

  it('agent-reviewed permit reads only the bound file and rejects a changed invocation input', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-read-permit-')))
    const target = path.join(root, 'note.txt')
    const alternate = path.join(root, 'other.txt')
    await fs.writeFile(target, 'approved bytes')
    await fs.writeFile(alternate, 'other bytes')
    try {
      const normalizedPath = await fs.realpath(target)
      const stat = await fs.stat(normalizedPath)
      const input = { path: target }
      const permit = finalizeAgentReadReview({
        toolName: 'read_file', toolInput: input, requestId: 'agent-r', toolUseId: 'agent-t',
        outcome: 'approved', answerer: 'agent',
        readPathFact: { rawPath: target, normalizedPath, zone: 'outside-workdir', targetKind: 'file', identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs } },
        approvedTargets: [{ factId: `fact-${normalizedPath}`, decisionRuleId: 'im-outside-read-review' }]
      })!
      const result = await resolveReadPermitTarget('read_file', input, { requestId: 'agent-r', toolUseId: 'agent-t', lane: 'wechat', readExecutionPermit: permit } as never)
      expect(result).toMatchObject({ ok: true, path: normalizedPath })
      if (result.ok && 'fileHandle' in result) {
        expect(await result.fileHandle.readFile('utf8')).toBe('approved bytes')
        await result.fileHandle.close()
      }
      await expect(resolveReadPermitTarget('read_file', { path: alternate }, { requestId: 'agent-r', toolUseId: 'agent-t', lane: 'wechat', readExecutionPermit: permit } as never))
        .resolves.toMatchObject({ ok: false, caseId: 'input-digest-mismatch' })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

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
