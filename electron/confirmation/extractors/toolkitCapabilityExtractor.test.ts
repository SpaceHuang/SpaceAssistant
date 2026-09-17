import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { extractToolkitCapability, createToolkitCapabilityExtractor } from './toolkitCapabilityExtractor'
import { signalTokenSet } from '../../../src/shared/policy/policyEngine'
import { DEFAULT_POLICY_RULES } from '../../../src/shared/policy/defaultRules'
import { runExtractors } from './runExtractors'
import { CapabilityRegistry } from '../../capabilities/registry'
import type { CapabilityDescriptor } from '../../capabilities/types'

function desc(overrides: Partial<CapabilityDescriptor> & { id: string; summary: string }): CapabilityDescriptor {
  return {
    family: 'env',
    keywords: [],
    paramsSchema: z.object({}).passthrough(),
    paramsDoc: '{}',
    returnsDoc: 'object',
    risk: 'read',
    handler: async () => ({}),
    ...overrides
  }
}

describe('toolkit-capability 提取器', () => {
  it('已知 read 能力：产出 read 风险信号与含 id/summary 的摘要', () => {
    const registry = new CapabilityRegistry()
    registry.register(desc({ id: 'env.system', summary: '获取宿主操作系统信息' }))
    const { signals, summary } = createToolkitCapabilityExtractor(registry)({ id: 'env.system' })
    expect(signals).toEqual([{ kind: 'toolkit-capability', capabilityId: 'env.system', risk: 'read' }])
    expect(summary).toContain('env.system')
    expect(summary).toContain('获取宿主操作系统信息')
  })

  it('已知 act 能力：risk=act', () => {
    const registry = new CapabilityRegistry()
    registry.register(desc({ id: 'action.mcp.add', summary: '添加 MCP 连接', risk: 'act', family: 'action' }))
    const { signals } = createToolkitCapabilityExtractor(registry)({ id: 'action.mcp.add' })
    expect(signals[0]).toMatchObject({ kind: 'toolkit-capability', risk: 'act' })
  })

  it('未知 id：fail-closed 按 act 处理', () => {
    const { signals, summary } = extractToolkitCapability({ id: 'env.nope' })
    expect(signals[0]).toMatchObject({ kind: 'toolkit-capability', capabilityId: 'env.nope', risk: 'act' })
    expect(summary).toContain('未知能力')
  })

  it('id 缺失：fail-closed 按 act 处理', () => {
    const { signals } = extractToolkitCapability({})
    expect(signals[0]).toMatchObject({ risk: 'act' })
  })
})

describe('signalTokenSet 对 toolkit-capability 的映射', () => {
  it('read 能力 → toolkit-read + toolkit-capability:<id>', () => {
    const tokens = signalTokenSet({
      toolName: 'toolkit.call',
      actionClass: 'execute',
      baseRiskLevel: 'high',
      signals: [{ kind: 'toolkit-capability', capabilityId: 'env.system', risk: 'read' }],
      summary: { text: 'x' }
    })
    expect(tokens.has('toolkit-capability')).toBe(true)
    expect(tokens.has('toolkit-capability:env.system')).toBe(true)
    expect(tokens.has('toolkit-read')).toBe(true)
    expect(tokens.has('toolkit-act')).toBe(false)
  })

  it('act 能力 → toolkit-act', () => {
    const tokens = signalTokenSet({
      toolName: 'toolkit.call',
      actionClass: 'execute',
      baseRiskLevel: 'high',
      signals: [{ kind: 'toolkit-capability', capabilityId: 'action.mcp.add', risk: 'act' }],
      summary: { text: 'x' }
    })
    expect(tokens.has('toolkit-act')).toBe(true)
    expect(tokens.has('toolkit-read')).toBe(false)
  })
})

describe('默认策略规则', () => {
  it('toolkit.read 免确认、toolkit.act 需确认（desktop lane）', () => {
    const allow = DEFAULT_POLICY_RULES.find((r) => r.id === 'toolkit-read-allow')
    const ask = DEFAULT_POLICY_RULES.find((r) => r.id === 'toolkit-act-ask')
    expect(allow).toMatchObject({
      match: { lane: ['desktop'], toolName: 'toolkit.call', signals: ['toolkit-read'] },
      action: 'allow'
    })
    expect(ask).toMatchObject({
      match: { lane: ['desktop'], toolName: 'toolkit.call', signals: ['toolkit-act'] },
      action: 'ask'
    })
  })
})

describe('runExtractors 集成', () => {
  it('descriptor 声明 toolkit-capability 时产出事实与摘要', () => {
    const facts = runExtractors(
      { toolName: 'toolkit.call', actionClass: 'execute', riskLevel: 'high', extractors: ['toolkit-capability'] },
      { id: 'env.system' },
      { workDir: '/w', homeDir: '/h' } as never
    )
    expect(facts.signals[0]).toMatchObject({ kind: 'toolkit-capability', risk: 'read' })
    expect(facts.summary.text).toContain('env.system')
  })
})
