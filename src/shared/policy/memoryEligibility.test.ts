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

describe('run_script 记忆资格按 findings 与 coverage 判定', () => {
  const scriptFacts = (signal?: Extract<ContentFacts['signals'][number], { kind: 'script-analysis' }>): ContentFacts => ({
    ...facts([]), toolName: 'run_script',
    signals: signal ? [signal] : []
  })

  it('拒绝缺少 script-analysis 的事实', () => {
    expect(deriveMemoryEligibility(scriptFacts(), 'desktop'))
      .toEqual({ eligibility: 'none', reasons: ['script-analysis-incomplete'] })
  })

  it('只有 complete 且空 findings/totalCount=0 才能获得桌面持久记忆', () => {
    expect(deriveMemoryEligibility(scriptFacts({ kind: 'script-analysis', findings: [], coverage: 'complete', totalCount: 0 }), 'desktop'))
      .toEqual({ eligibility: 'persistent', reasons: [] })
  })

  it('12 类任一发现均禁止脚本记忆', () => {
    const classes = [
      'process-creation', 'destructive-fs', 'dynamic-execution', 'dynamic-import', 'native-code-load', 'network-api',
      'file-write', 'cwd-change', 'reflection', 'alias-resolution', 'decode-then-exec', 'dynamic-dispatch'
    ] as const
    for (const findingClass of classes) {
      const finding = {
        pattern: 'A1', class: findingClass,
        range: { startLine: 1, startCol: 1, endLine: 1, endCol: 4 }, snippet: 'x',
        evidence: { kind: 'process-create' as const, module: 'os', attr: 'system' }
      }
      expect(deriveMemoryEligibility(scriptFacts({ kind: 'script-analysis', findings: [finding], coverage: 'complete', totalCount: 1 }), 'desktop'))
        .toEqual({ eligibility: 'none', reasons: [findingClass === 'network-api' ? 'script-network-or-uncertified' : 'script-not-clean'] })
    }
  })

  it.each([
    ['findings present', { findings: [{ pattern: 'A1', class: 'process-creation', range: { startLine: 1, startCol: 1, endLine: 1, endCol: 4 }, snippet: 'x', evidence: { kind: 'process-create', module: 'os', attr: 'system' } }], coverage: 'complete', totalCount: 1 }, 'script-not-clean'],
    ['partial coverage', { findings: [], coverage: 'partial', totalCount: 0 }, 'script-analysis-incomplete'],
    ['failed coverage', { findings: [], coverage: 'failed', totalCount: 0 }, 'script-analysis-incomplete'],
    ['total mismatch', { findings: [], coverage: 'complete', totalCount: 1 }, 'script-analysis-incomplete']
  ] as const)('%s cannot gain reusable memory', (_name, payload, reason) => {
    const result = deriveMemoryEligibility(scriptFacts({ kind: 'script-analysis', ...payload }), 'desktop')
    expect(result.eligibility).toBe('none')
    expect(result.reasons).toContain(reason)
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

  it('remote outbound actions never gain reusable memory eligibility', () => {
    const outbound: ContentFacts = { ...facts([{ kind: 'outbound-target', channel: 'email', recipient: 'owner@example.com' }]), actionClass: 'outbound' }
    for (const lane of ['wechat', 'feishu'] as const) {
      expect(deriveMemoryEligibility(outbound, lane, 'user')).toEqual({ eligibility: 'none', reasons: ['outbound-never-remembered'] })
    }
    expect(deriveMemoryEligibility(outbound, 'desktop', 'user').eligibility).toBe('persistent')
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
