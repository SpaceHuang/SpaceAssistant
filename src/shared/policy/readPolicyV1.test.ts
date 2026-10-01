import { describe, expect, it } from 'vitest'
import { validateDesktopReadV1 } from './readPolicyV1'
import type { ContentFacts } from '../confirmation/types'
const readFileFacts: ContentFacts = { toolName: 'read_file', actionClass: 'read', baseRiskLevel: 'low', signals: [], summary: { text: 'read' } }
const grepFacts: ContentFacts = { toolName: 'grep', actionClass: 'read', baseRiskLevel: 'low', signals: [], summary: { text: 'grep' } }
const context = { lane: 'desktop' as const, sessionId: 's' }
describe('desktop read V1 target validation', () => {
  it.each(['workdir-normal', 'outside-workdir', 'sensitive-file', 'system-dir'] as const)('accepts valid file target for zone %s without deciding policy', (zone) => {
    expect(validateDesktopReadV1({ facts: readFileFacts, context, zone, targetKind: 'file', hasExplicitPath: true })).toBeUndefined()
    expect(validateDesktopReadV1({ facts: grepFacts, context, zone, targetKind: 'file', hasExplicitPath: true })).toBeUndefined()
  })

  it('grep 放行 directory 目标（grep 递归搜索能力释放 §7.2）', () => {
    expect(validateDesktopReadV1({ facts: grepFacts, context, zone: 'workdir-normal', targetKind: 'directory', hasExplicitPath: true })).toBeUndefined()
  })

  it('read_file 仍拒绝 directory 目标（N8 不回归）', () => {
    expect(validateDesktopReadV1({ facts: readFileFacts, context, zone: 'workdir-normal', targetKind: 'directory', hasExplicitPath: true }))
      .toMatchObject({ type: 'deny', ruleId: 'read-v1-target-unsupported' })
  })

  it.each(['special', 'unknown'] as const)('%s 目标对读取工具仍 fail closed', (targetKind) => {
    expect(validateDesktopReadV1({ facts: readFileFacts, context, zone: 'workdir-normal', targetKind, hasExplicitPath: true })).toMatchObject({ type: 'deny', ruleId: 'read-v1-target-unsupported' })
    expect(validateDesktopReadV1({ facts: grepFacts, context, zone: 'workdir-normal', targetKind, hasExplicitPath: true })).toMatchObject({ type: 'deny', ruleId: 'read-v1-target-unsupported' })
  })

  it('通配 path 报专用 ruleId read-path-pattern-unsupported（与目标类型不支持分离）', () => {
    expect(validateDesktopReadV1({ facts: grepFacts, context, zone: 'workdir-normal', targetKind: 'unknown', hasExplicitPath: true, hasUnsupportedPattern: true }))
      .toMatchObject({ type: 'deny', ruleId: 'read-path-pattern-unsupported' })
    expect(validateDesktopReadV1({ facts: readFileFacts, context, zone: 'workdir-normal', targetKind: 'file', hasExplicitPath: true, hasUnsupportedPattern: true }))
      .toMatchObject({ type: 'deny', ruleId: 'read-path-pattern-unsupported' })
  })

  it('rejects missing paths', () => {
    expect(validateDesktopReadV1({ facts: readFileFacts, context, hasExplicitPath: false })).toMatchObject({ type: 'deny', ruleId: 'read-v1-facts-missing' })
  })
})
