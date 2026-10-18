import { describe, expect, it } from 'vitest'
import { buildWriteExecutionPermit, validateWriteExecutionPermit } from './writeExecutionPermit'
import type { WritePathFact } from './extractors/writePathFacts'

const fact: WritePathFact = {
  rawPath: '../outside/new.txt', normalizedPath: '/tmp/outside/new.txt', zone: 'outside-workdir', targetKind: 'missing',
  parentReal: '/tmp/outside', parentIdentity: { dev: 1, ino: 2, mode: 0o40755, size: 10, mtimeMs: 20, nlink: 1 }
}
const input = { path: '../outside/new.txt', content: 'data' }
const outputBinding = {
  kind: 'output' as const,
  path: '/results/reports/summary.txt',
  ancestor: '/results',
  relativeSuffix: 'reports/summary.txt',
  outputRoot: '/results',
  expectedType: 'file' as const,
  rawText: 'write the summary',
  resolverVersion: 3,
  rootsDigest: 'output-roots-digest',
  taskRevision: 8
}
const outputRunDir = '/results/20261018-07'
const outputTarget: WritePathFact = {
  ...fact,
  rawPath: '/results/20261018-07/reports/summary.txt',
  normalizedPath: '/results/20261018-07/reports/summary.txt',
  zone: 'outside-workdir',
  targetKind: 'missing',
  parentReal: '/results/20261018-07/reports'
}

describe('write execution permit', () => {
  it('绑定 request、toolUse、输入摘要和完整目标事实', () => {
    const permit = buildWriteExecutionPermit({ requestId: 'r1', toolUseId: 'u1', toolName: 'write_file', input, target: fact, decisionRuleId: 'write-outside-confirm', approval: 'confirmed' })
    expect(validateWriteExecutionPermit(permit, { requestId: 'r1', toolUseId: 'u1', toolName: 'write_file', input })).toEqual({ ok: true })
    expect(validateWriteExecutionPermit(permit, { requestId: 'r1', toolUseId: 'u2', toolName: 'write_file', input })).toMatchObject({ ok: false, caseId: 'write-permit-binding-mismatch' })
    expect(validateWriteExecutionPermit(permit, { requestId: 'r1', toolUseId: 'u1', toolName: 'write_file', input: { ...input, content: 'changed' } })).toMatchObject({ ok: false, caseId: 'write-input-digest-mismatch' })
  })

  it('许可独立保存并深冻结目标与父目录身份快照', () => {
    const mutableFact = structuredClone(fact)
    const permit = buildWriteExecutionPermit({ requestId: 'r1', toolUseId: 'u1', toolName: 'write_file', input, target: mutableFact, decisionRuleId: 'write-outside-confirm', approval: 'confirmed' })
    expect(Object.isFrozen(permit)).toBe(true)
    expect(Object.isFrozen(permit.target)).toBe(true)
    expect(Object.isFrozen(permit.target.parentIdentity)).toBe(true)
    expect(permit.target.parentIdentity).not.toBe(mutableFact.parentIdentity)

    mutableFact.parentIdentity.ino = 99
    expect(permit.target.parentIdentity.ino).toBe(2)
    expect(validateWriteExecutionPermit(permit, { requestId: 'r1', toolUseId: 'u1', toolName: 'write_file', input })).toEqual({ ok: true })
  })

  it('对象键顺序变化不影响相同批准参数的 digest', () => {
    const permit = buildWriteExecutionPermit({ requestId: 'r1', toolUseId: 'u1', toolName: 'write_file', input: { path: input.path, content: input.content }, target: fact, decisionRuleId: 'write-outside-confirm', approval: 'confirmed' })
    expect(validateWriteExecutionPermit(permit, { requestId: 'r1', toolUseId: 'u1', toolName: 'write_file', input: { content: input.content, path: input.path } })).toEqual({ ok: true })
  })

  it('automation 输出 permit 必须绑定精确归档目标，缺 binding 或目标漂移均拒绝', () => {
    const expected = { requestId: 'r-output', toolUseId: 'u-output', toolName: 'write_file' as const, input: { path: outputTarget.rawPath, content: 'result' } }
    const valid = buildWriteExecutionPermit({
      ...expected,
      lane: 'automation',
      target: outputTarget,
      decisionRuleId: 'automation-bound-output-write-allow',
      approval: 'auto-allow',
      automationOutputBinding: { binding: outputBinding, runOutputDir: outputRunDir }
    } as never)
    expect(validateWriteExecutionPermit(valid, expected)).toEqual({ ok: true })

    const missing = buildWriteExecutionPermit({ ...expected, target: outputTarget, decisionRuleId: 'automation-bound-output-write-allow', approval: 'auto-allow' } as never)
    expect(validateWriteExecutionPermit(missing, expected)).toMatchObject({ ok: false, caseId: 'automation-output-binding-missing' })

    const driftedTarget = { ...outputTarget, normalizedPath: '/results/20261018-07/reports/other.txt' }
    const drifted = buildWriteExecutionPermit({
      ...expected,
      lane: 'automation',
      target: driftedTarget,
      decisionRuleId: 'automation-bound-output-write-allow',
      approval: 'auto-allow',
      automationOutputBinding: { binding: outputBinding, runOutputDir: outputRunDir }
    } as never)
    expect(validateWriteExecutionPermit(drifted, expected)).toMatchObject({ ok: false, caseId: 'automation-output-target-mismatch' })
  })

  it('即使策略兜底被配置放行，automation lane 的写 permit 仍必须携带本次输出 binding', () => {
    const expected = { requestId: 'r-output-fallback', toolUseId: 'u-output-fallback', toolName: 'write_file' as const, input: { path: outputTarget.rawPath, content: 'result' } }
    const permit = buildWriteExecutionPermit({
      ...expected,
      lane: 'automation',
      target: outputTarget,
      decisionRuleId: 'automation-default-confirm',
      approval: 'confirmed'
    } as never)
    expect(validateWriteExecutionPermit(permit, expected)).toMatchObject({ ok: false, caseId: 'automation-output-binding-missing' })
  })

  it('目录型输出 binding 允许其归档子树中的文件目标', () => {
    const binding = { ...outputBinding, path: '/results/reports', relativeSuffix: 'reports', expectedType: 'directory' as const }
    const target = { ...outputTarget, rawPath: '/results/20261018-07/reports/monthly.txt', normalizedPath: '/results/20261018-07/reports/monthly.txt', parentReal: '/results/20261018-07/reports' }
    const expected = { requestId: 'r-output-dir', toolUseId: 'u-output-dir', toolName: 'write_file' as const, input: { path: target.rawPath, content: 'result' } }
    const permit = buildWriteExecutionPermit({
      ...expected, lane: 'automation', target, decisionRuleId: 'automation-bound-output-write-allow', approval: 'auto-allow',
      automationOutputBinding: { binding, runOutputDir: outputRunDir }
    } as never)
    expect(validateWriteExecutionPermit(permit, expected)).toEqual({ ok: true })
  })
})
