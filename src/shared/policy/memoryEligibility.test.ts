import { describe, expect, it } from 'vitest'
import type { ContentFacts } from '../confirmation/types'
import { deriveMemoryEligibility } from './memoryEligibility'

const facts = (signals: ContentFacts['signals']): ContentFacts => ({
  toolName: 'run_shell', actionClass: 'execute', baseRiskLevel: 'high', signals, summary: { text: 'x' }
})

describe('MemoryEligibility', () => {
  it('disables memory for incomplete analysis and sensitive paths', () => {
    expect(deriveMemoryEligibility(facts([{ kind: 'extraction-failed', reason: 'partial' }]), 'desktop')).toEqual({
      eligibility: 'none', reasons: ['analysis-incomplete']
    })
    expect(deriveMemoryEligibility(facts([{ kind: 'path-target', path: '.env', zone: 'sensitive-file' }]), 'desktop')).toEqual({
      eligibility: 'none', reasons: ['path-risk']
    })
  })

  it('disables memory for script path extraction unknown(P1:缓存不得绕过未建模路径)', () => {
    for (const unknownReason of ['unmodeled-call', 'dynamic-execution'] as const) {
      expect(deriveMemoryEligibility(facts([
        { kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: unknownReason === 'dynamic-execution', unknownReason }
      ]), 'desktop')).toEqual({ eligibility: 'none', reasons: ['script-path-unknown'] })
    }
  })

  it('disables memory for outside-workdir and system-dir path risks', () => {
    for (const zone of ['outside-workdir', 'system-dir'] as const) {
      expect(deriveMemoryEligibility(facts([{ kind: 'path-target', path: '/risk', zone }]), 'desktop')).toEqual({
        eligibility: 'none', reasons: ['path-risk']
      })
    }
  })

  it('allows only session memory for remote lanes', () => {
    const result = deriveMemoryEligibility(facts([{ kind: 'command-sequence', commands: [], persistable: true }]), 'feishu')
    expect(result.eligibility).toBe('session')
  })

  it('allows persistent memory only for complete desktop facts', () => {
    expect(deriveMemoryEligibility(facts([{ kind: 'command-sequence', commands: [], persistable: true }]), 'desktop').eligibility)
      .toBe('persistent')
  })

  it('disables memory for compound or otherwise non-persistable commands', () => {
    expect(deriveMemoryEligibility(facts([{ kind: 'command-sequence', commands: [], persistable: false }]), 'desktop'))
      .toEqual({ eligibility: 'none', reasons: ['non-persistable-command'] })
    expect(deriveMemoryEligibility(facts([{ kind: 'command-sequence', commands: [] }]), 'desktop'))
      .toEqual({ eligibility: 'none', reasons: ['non-persistable-command'] })
  })
})

describe('MemoryEligibility 回答者维度（I3：记忆只源于人类）', () => {
  const persistable = [{ kind: 'command-sequence' as const, commands: [], persistable: true as const }]

  it('answererKind 为 agent / deny 时一律 none（理由 non-human-answerer）', () => {
    for (const answererKind of ['agent', 'deny'] as const) {
      expect(deriveMemoryEligibility(facts(persistable), 'desktop', answererKind)).toEqual({
        eligibility: 'none',
        reasons: ['non-human-answerer']
      })
    }
  })

  it('answererKind=user（含缺省）时输出与既有向量逐项一致', () => {
    expect(deriveMemoryEligibility(facts(persistable), 'desktop', 'user')).toEqual(
      deriveMemoryEligibility(facts(persistable), 'desktop')
    )
    expect(deriveMemoryEligibility(facts([{ kind: 'extraction-failed', reason: 'partial' }]), 'desktop', 'user')).toEqual({
      eligibility: 'none', reasons: ['analysis-incomplete']
    })
    expect(deriveMemoryEligibility(facts(persistable), 'feishu', 'user').eligibility).toBe('session')
    expect(deriveMemoryEligibility(facts(persistable), 'desktop', 'user').eligibility).toBe('persistent')
  })
})

describe('B1：unsupported 信号阻断持久记忆资格（决策缓存旁路修复）', () => {
  it('shell-unsupported-structure 信号 → eligibility=none（确认一次不得写 90 天 allow 缓存）', () => {
    const r = deriveMemoryEligibility(
      facts([{ kind: 'shell-unsupported-structure', structures: ['conditional-block'], reason: 'structure' }]),
      'desktop'
    )
    expect(r.eligibility).toBe('none')
    expect(r.reasons).toContain('shell-analysis-incomplete')
  })

  it('unsupported + persistable=true 的组合同样阻断（树解析失败但简单解析器 persistable 的真实形态）', () => {
    const r = deriveMemoryEligibility(
      facts([
        { kind: 'command-sequence', commands: [], persistable: true },
        { kind: 'shell-unsupported-structure', structures: [], reason: 'structure' }
      ]),
      'desktop'
    )
    expect(r.eligibility).toBe('none')
  })
})
