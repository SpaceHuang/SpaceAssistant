import { describe, expect, it } from 'vitest'
import { runToolConfirmation } from './runToolConfirmation'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import type {
  ConfirmationChannel,
  ConfirmOutcome,
  EnvFacts,
  ExecutionContext,
  ToolActionDescriptor
} from '../../src/shared/confirmation/types'

const env: EnvFacts = { os: 'win32', workDir: 'C:\\work', sensitivePaths: [] }
const desktop: ExecutionContext = { lane: 'desktop', origin: { kind: 'direct-owner' }, sessionId: 's1' }
const deps = { cache: { lookup: () => null }, config: {}, migrationComplete: false }

function channel(outcome: ConfirmOutcome): ConfirmationChannel {
  return { request: async () => outcome, cancel: () => undefined }
}

const readDesc: ToolActionDescriptor = { toolName: 'read_file', actionClass: 'read', riskLevel: 'low', extractors: [] }
const writeDesc: ToolActionDescriptor = {
  toolName: 'write_file',
  actionClass: 'write',
  riskLevel: 'medium',
  extractors: ['path-classifier']
}

describe('runToolConfirmation（§5.5 直线流程）', () => {
  it('auto-allow（read_file）直接放行，不调用通道', async () => {
    let called = false
    const r = await runToolConfirmation({
      descriptor: readDesc,
      toolInput: { path: 'a.txt' },
      env,
      context: desktop,
      rules: DEFAULT_POLICY_RULES,
      deps,
      channel: { request: async () => { called = true; return { kind: 'approved' } }, cancel: () => undefined }
    })
    expect(r.decision.type).toBe('auto-allow')
    expect(r.approved).toBe(true)
    expect(called).toBe(false)
  })

  it('deny（危险脚本）直接拒绝', async () => {
    const r = await runToolConfirmation({
      descriptor: { toolName: 'run_script', actionClass: 'execute', riskLevel: 'high', extractors: ['script-analysis'] },
      toolInput: { code: "import ctypes\nctypes.CDLL('a')" },
      env,
      context: desktop,
      rules: DEFAULT_POLICY_RULES,
      deps,
      channel: channel({ kind: 'approved' })
    })
    expect(r.decision.type).toBe('deny')
    expect(r.approved).toBe(false)
  })

  it('require-confirm（write_file）经通道批准后 approved=true', async () => {
    const r = await runToolConfirmation({
      descriptor: writeDesc,
      toolInput: { path: 'a.txt', content: 'x' },
      env,
      context: desktop,
      rules: DEFAULT_POLICY_RULES,
      deps,
      channel: channel({ kind: 'approved' })
    })
    expect(r.decision.type).toBe('require-confirm')
    expect(r.approved).toBe(true)
  })

  it('require-confirm 但用户拒绝 → approved=false', async () => {
    const r = await runToolConfirmation({
      descriptor: writeDesc,
      toolInput: { path: 'a.txt', content: 'x' },
      env,
      context: desktop,
      rules: DEFAULT_POLICY_RULES,
      deps,
      channel: channel({ kind: 'rejected' })
    })
    expect(r.approved).toBe(false)
  })
})
