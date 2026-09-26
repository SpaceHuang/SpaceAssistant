import { describe, expect, it } from 'vitest'
import { buildReadExecutionPermit } from './readExecutionPermit'
import { validateReadExecutionBoundary } from './readExecutionBoundary'

const permit = buildReadExecutionPermit({
  requestId: 'req-1', toolUseId: 'tool-1', toolName: 'read_file',
  input: { path: '/tmp/a.txt' },
  facts: [{ factId: 'fact-1', decisionRuleId: 'read-group-workdir-allow', normalizedPath: '/tmp/a.txt', zone: 'workdir-normal', targetKind: 'file' }]
})

describe('validateReadExecutionBoundary', () => {
  it.each(['file', 'missing', 'symlink', 'special', 'unknown'] as const)('非目录目标 %s 必须携带匹配 permit', (targetKind) => {
    const input = { path: `/tmp/${targetKind}` }
    const p = buildReadExecutionPermit({ requestId: 'req-1', toolUseId: 'tool-1', toolName: 'read_file', input, facts: [{ factId: `fact-${targetKind}`, decisionRuleId: 'read-group-workdir-allow', normalizedPath: input.path, zone: 'workdir-normal', targetKind }] })
    expect(validateReadExecutionBoundary({ toolName: 'read_file', input, requestId: 'req-1', toolUseId: 'tool-1', permit: p, targetKind })).toEqual({ ok: true })
    expect(validateReadExecutionBoundary({ toolName: 'read_file', input, requestId: 'req-1', toolUseId: 'tool-1', targetKind })).toEqual({ ok: false, caseId: 'read-permit-missing' })
  })
  it('通过 gate 绑定的读取许可', () => {
    expect(validateReadExecutionBoundary({ toolName: 'read_file', input: { path: '/tmp/a.txt' }, requestId: 'req-1', toolUseId: 'tool-1', permit })).toEqual({ ok: true })
  })
  it('拒绝输入摘要变化、请求绑定变化和目标事实变化', () => {
    expect(validateReadExecutionBoundary({ toolName: 'read_file', input: { path: '/tmp/other.txt' }, requestId: 'req-1', toolUseId: 'tool-1', permit })).toEqual({ ok: false, caseId: 'input-digest-mismatch' })
    expect(validateReadExecutionBoundary({ toolName: 'read_file', input: { path: '/tmp/a.txt' }, requestId: 'req-2', toolUseId: 'tool-1', permit })).toEqual({ ok: false, caseId: 'permit-binding-mismatch' })
    const changed = { ...permit, targets: [{ ...permit.targets[0], normalizedPath: '/tmp/other.txt' }] }
    expect(validateReadExecutionBoundary({ toolName: 'read_file', input: { path: '/tmp/a.txt' }, requestId: 'req-1', toolUseId: 'tool-1', permit: changed, expectedFacts: permit.targets })).toEqual({ ok: false, caseId: 'fact-target-mismatch' })
  })
  it('缺少许可时拒绝所有读取工具，其他工具放行', () => {
    expect(validateReadExecutionBoundary({ toolName: 'read_file', input: {}, requestId: 'req-1', toolUseId: 'tool-1' })).toEqual({ ok: false, caseId: 'read-permit-missing' })
    expect(validateReadExecutionBoundary({ toolName: 'write_file', input: {}, requestId: 'req-1', toolUseId: 'tool-1' })).toEqual({ ok: true })
    expect(validateReadExecutionBoundary({ toolName: 'grep', input: { path: '/tmp/src' }, requestId: 'req-1', toolUseId: 'tool-1', targetKind: 'directory' })).toEqual({ ok: false, caseId: 'read-permit-missing' })
    expect(validateReadExecutionBoundary({ toolName: 'grep', input: { pattern: 'needle' }, requestId: 'req-1', toolUseId: 'tool-1' })).toEqual({ ok: false, caseId: 'read-permit-missing' })
    expect(validateReadExecutionBoundary({ toolName: 'list_directory', input: { path: '/tmp/src' }, requestId: 'req-1', toolUseId: 'tool-1', targetKind: 'directory' })).toEqual({ ok: false, caseId: 'read-permit-missing' })
    expect(validateReadExecutionBoundary({ toolName: 'read_file', input: { path: '/tmp/missing.txt' }, requestId: 'req-1', toolUseId: 'tool-1', targetKind: 'missing', permit: buildReadExecutionPermit({ requestId: 'req-1', toolUseId: 'tool-1', toolName: 'read_file', input: { path: '/tmp/missing.txt' }, facts: [{ factId: 'fact-missing', decisionRuleId: 'read-group-workdir-allow', normalizedPath: '/tmp/missing.txt', zone: 'workdir-normal', targetKind: 'missing' }] }) })).toEqual({ ok: true })
  })
})
