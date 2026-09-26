import { describe, expect, it } from 'vitest'
import { buildReadExecutionPermit, readInputDigest, validateReadExecutionPermit } from './readExecutionPermit'

const facts = [{ factId: 'fact-1', decisionRuleId: 'read-group-workdir-allow', normalizedPath: '/work/a.txt', zone: 'workdir-normal' as const, targetKind: 'file' as const }]

describe('read execution permit', () => {
  it('binds request, input digest, tool and fact target', () => {
    const permit = buildReadExecutionPermit({ requestId: 'req-1', toolUseId: 'tool-1', toolName: 'read_file', input: { path: 'a.txt' }, facts })
    expect(validateReadExecutionPermit(permit, { requestId: 'req-1', toolUseId: 'tool-1', toolName: 'read_file', input: { path: 'a.txt' }, facts })).toEqual({ ok: true })
  })

  it('rejects input or target changes', () => {
    const permit = buildReadExecutionPermit({ requestId: 'req-1', toolUseId: 'tool-1', toolName: 'read_file', input: { path: 'a.txt' }, facts })
    expect(validateReadExecutionPermit(permit, { requestId: 'req-1', toolUseId: 'tool-1', toolName: 'read_file', input: { path: 'b.txt' }, facts })).toMatchObject({ ok: false, caseId: 'input-digest-mismatch' })
  })

  it('递归绑定嵌套输入字段，嵌套参数变化时拒绝旧许可', () => {
    const permit = buildReadExecutionPermit({
      requestId: 'req-nested', toolUseId: 'tool-nested', toolName: 'read_file',
      input: { path: '/tmp/a', options: { limit: 1 } }, facts
    })
    expect(readInputDigest({ path: '/tmp/a', options: { limit: 1 } })).not.toBe(readInputDigest({ path: '/tmp/a', options: { limit: 999 } }))
    expect(validateReadExecutionPermit(permit, {
      requestId: 'req-nested', toolUseId: 'tool-nested', toolName: 'read_file',
      input: { path: '/tmp/a', options: { limit: 999 } }, facts
    })).toEqual({ ok: false, caseId: 'input-digest-mismatch' })
  })

  it('对象键顺序变化不改变递归输入摘要', () => {
    expect(readInputDigest({ path: '/tmp/a', options: { limit: 1, mode: 'text' } }))
      .toBe(readInputDigest({ options: { mode: 'text', limit: 1 }, path: '/tmp/a' }))
  })
})

describe('buildUserConfirmedReadExecutionPermit', () => {
  it('仅消费已批准登记并生成一次性许可', async () => {
    const { ReadConfirmationRegistry } = await import('./readConfirmationRegistry')
    const registry = new ReadConfirmationRegistry({ now: () => 10 })
    const input = { requestId: 'r', toolUseId: 't', toolName: 'read_file' as const, input: { path: '/tmp/a' }, facts: [{ factId: 'f', decisionRuleId: 'rule', normalizedPath: '/tmp/a', zone: 'sensitive-file' as const, targetKind: 'file' as const }] }
    const digest = readInputDigest(input.input)
    registry.register({ requestId: 'r', toolUseId: 't', inputDigest: digest, factIds: ['f'], ruleId: 'rule', expiresAt: 100 })
    expect(registry.approve({ requestId: 'r', toolUseId: 't', inputDigest: digest, approvedFactIds: ['f'] })).toBe(true)
    const { buildUserConfirmedReadExecutionPermit } = await import('./readExecutionPermit')
    expect(buildUserConfirmedReadExecutionPermit(input, registry).targets).toEqual(input.facts)
    expect(() => buildUserConfirmedReadExecutionPermit(input, registry)).toThrow('READ_CONFIRMATION_NOT_APPROVED')
  })
})


describe('permit approved target mapping', () => {
  it('每个 permit target 保留真实 decisionRuleId，并拒绝占位规则', () => {
    const facts = [{ factId: 'f', decisionRuleId: 'read-group-workdir-allow', normalizedPath: '/tmp/a', zone: 'workdir-normal' as const, targetKind: 'file' as const }]
    const permit = buildReadExecutionPermit({ requestId: 'r', toolUseId: 't', toolName: 'read_file', input: { path: '/tmp/a' }, facts })
    expect(permit.targets[0]?.decisionRuleId).toBe('read-group-workdir-allow')
    expect(() => buildReadExecutionPermit({ requestId: 'r', toolUseId: 't', toolName: 'read_file', input: { path: '/tmp/a' }, facts: [{ ...facts[0]!, decisionRuleId: 'unknown' }] })).toThrow('INVALID_READ_PERMIT_TARGET')
  })

  it.each([
    ['Windows 盘符路径', 'C:\\Users\\alice\\a.txt'],
    ['UNC 路径', '\\\\server\\share\\a.txt']
  ])('接受 %s 作为绝对目标', (_label, normalizedPath) => {
    const permit = buildReadExecutionPermit({
      requestId: 'windows-req', toolUseId: 'windows-tool', toolName: 'read_file', input: { path: normalizedPath },
      facts: [{ factId: 'windows-fact', decisionRuleId: 'read-group-workdir-allow', normalizedPath, zone: 'workdir-normal', targetKind: 'file' }]
    })
    expect(permit.targets[0]?.normalizedPath).toBe(normalizedPath)
  })

  it('Windows 盘符路径通过真人确认登记并生成可校验 permit', async () => {
    const { ReadConfirmationRegistry } = await import('./readConfirmationRegistry')
    const { buildUserConfirmedReadExecutionPermit, readInputDigest } = await import('./readExecutionPermit')
    const registry = new ReadConfirmationRegistry({ now: () => 10 })
    const target = { factId: 'windows-confirm-fact', decisionRuleId: 'read-group-sensitive-confirm', normalizedPath: 'C:\\Users\\alice\\.env', zone: 'sensitive-file' as const, targetKind: 'file' as const }
    const input = { path: target.normalizedPath }
    registry.register({ requestId: 'windows-confirm-req', toolUseId: 'windows-confirm-tool', inputDigest: readInputDigest(input), factIds: [target.factId], ruleId: target.decisionRuleId, expiresAt: 100 })
    expect(registry.approve({ requestId: 'windows-confirm-req', toolUseId: 'windows-confirm-tool', inputDigest: readInputDigest(input), approvedFactIds: [target.factId], ruleId: target.decisionRuleId })).toBe(true)
    const permitInput = { requestId: 'windows-confirm-req', toolUseId: 'windows-confirm-tool', toolName: 'read_file' as const, input, facts: [target] }
    const permit = buildUserConfirmedReadExecutionPermit(permitInput, registry)
    expect(validateReadExecutionPermit(permit, permitInput)).toEqual({ ok: true })
  })

  it('仍拒绝 Windows 风格相对路径', () => {
    expect(() => buildReadExecutionPermit({
      requestId: 'windows-req', toolUseId: 'windows-tool', toolName: 'read_file', input: { path: 'alice\\a.txt' },
      facts: [{ factId: 'windows-fact', decisionRuleId: 'read-group-workdir-allow', normalizedPath: 'alice\\a.txt', zone: 'workdir-normal', targetKind: 'file' }]
    })).toThrow('INVALID_READ_PERMIT_TARGET')
  })
})
