import { describe, expect, it } from 'vitest'
import type {
  ContentFacts,
  DecisionCacheView,
  ExecutionContext,
  PolicyEngineDeps
} from '../confirmation/types'
import { DEFAULT_POLICY_RULES } from './defaultRules'
import { buildMemoryTiers, decide, decideIngress } from './policyEngine'

function mkFacts(
  toolName: string,
  actionClass: ContentFacts['actionClass'],
  signals: ContentFacts['signals'],
  baseRiskLevel: ContentFacts['baseRiskLevel'] = 'medium'
): ContentFacts {
  return { toolName, actionClass, baseRiskLevel, signals, summary: { text: 'summary' } }
}

function mkContext(
  lane: ExecutionContext['lane'],
  remoteWriteGrant?: ExecutionContext['remoteWriteGrant']
): ExecutionContext {
  return {
    lane,
    origin: { kind: 'direct-owner' },
    sessionId: 's1',
    ...(remoteWriteGrant ? { remoteWriteGrant } : {})
  }
}

function emptyCache(): DecisionCacheView {
  return { lookup: () => null }
}

function cacheWith(decision: 'allow' | 'deny'): DecisionCacheView {
  return {
    lookup: () => ({
      id: 'c1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      key: { kind: 'shell-command', verb: 'ping', level: 'exact' } as any,
      decision,
      lane: '*',
      scope: 'persistent',
      createdAt: 1,
      lastHitAt: 1,
      hitCount: 1,
      source: 'user-confirm'
    })
  }
}

function deps(overrides: Partial<PolicyEngineDeps> = {}): PolicyEngineDeps {
  return {
    cache: emptyCache(),
    config: {},
    migrationComplete: false,
    ...overrides
  }
}

describe('decide：脚本规则族（规范条目顺序）', () => {
  it('桌面 run_script clean 免确认（script-clean-allow-desktop）', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'clean', patterns: [] }], 'high'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('auto-allow')
  })

  it('桌面 clean+script-network 走确认（不被 clean 放行抢先命中）', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [
        { kind: 'script-analysis', signal: 'clean', patterns: [] },
        { kind: 'script-network', patterns: ['socket'] }
      ], 'high'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.ruleId).toBe('script-network-ask-desktop')
  })

  it('远程 clean+script-network 直接拒绝（不升级为问）', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [
        { kind: 'script-analysis', signal: 'clean', patterns: [] },
        { kind: 'script-network', patterns: ['socket'] }
      ], 'high'),
      mkContext('wechat'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('deny')
    expect(d.type === 'deny' && d.ruleId).toBe('script-network-deny-remote')
  })

  it('远程 clean+script-uncertified 必确认（即使 remoteScriptRequiresConfirm=false）', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [
        { kind: 'script-analysis', signal: 'clean', patterns: [] },
        { kind: 'script-uncertified' }
      ], 'high'),
      mkContext('wechat'),
      DEFAULT_POLICY_RULES,
      deps({ config: { remoteScriptRequiresConfirm: false }, migrationComplete: true })
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.ruleId).toBe('script-uncertified-ask-remote')
  })

  it('远程 clean 已认证 + remoteScriptRequiresConfirm=false + 迁移完成 → 免确认', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'clean', patterns: [] }], 'high'),
      mkContext('wechat'),
      DEFAULT_POLICY_RULES,
      deps({ config: { remoteScriptRequiresConfirm: false }, migrationComplete: true })
    )
    expect(d.type).toBe('auto-allow')
    expect(d.type === 'auto-allow' && d.ruleId).toBe('script-clean-certified-remote')
  })

  it('远程 clean 已认证 + remoteScriptRequiresConfirm=true（默认）→ 确认', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'clean', patterns: [] }], 'high'),
      mkContext('feishu'),
      DEFAULT_POLICY_RULES,
      deps({ config: {}, migrationComplete: true })
    )
    expect(d.type).toBe('require-confirm')
  })
})

describe('decide：脚本规则作用域不外溢', () => {
  it('桌面 run_shell 携带通用 network-egress 不被脚本规则卷入（按 execute 默认走确认）', () => {
    const d = decide(
      mkFacts('run_shell', 'execute', [{ kind: 'network-egress', domains: ['example.com'] }], 'high'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'deny').toBe(false)
  })

  it('桌面 browser navigate 不因脚本规则出现确认（按 outbound 默认放行）', () => {
    const d = decide(
      mkFacts('browser', 'outbound', [{ kind: 'network-egress', domains: ['example.com'] }], 'low'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('auto-allow')
  })
})

describe('decide：自动审批器（desktop-auto-approve）不与截胡', () => {
  it('confirmMode=auto 且评估器批准 write_file → 自动放行', () => {
    const d = decide(
      mkFacts('write_file', 'write', [{ kind: 'path-target', path: 'a.txt', zone: 'workdir-normal' }], 'medium'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps({
        config: { confirmMode: 'auto' },
        autoEvaluator: () => ({ approve: true, reason: '低风险' })
      })
    )
    expect(d.type).toBe('auto-allow')
    expect(d.type === 'auto-allow' && d.ruleId).toBe('desktop-auto-approve')
  })

  it('confirmMode=auto 下桌面 read_file 不被评估器截胡（默认放行）', () => {
    const d = decide(
      mkFacts('read_file', 'read', [], 'low'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps({
        config: { confirmMode: 'auto' },
        autoEvaluator: () => ({ approve: true, reason: '不该被调用' })
      })
    )
    expect(d.type).toBe('auto-allow')
    expect(d.type === 'auto-allow' && d.ruleId).not.toBe('desktop-auto-approve')
  })

  it('confirmMode=auto 下桌面 clean 脚本仍免确认（评估器不拦截 run_script）', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'clean', patterns: [] }], 'high'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps({
        config: { confirmMode: 'auto' },
        autoEvaluator: () => ({ approve: true, reason: '不该被调用' })
      })
    )
    expect(d.type).toBe('auto-allow')
    expect(d.type === 'auto-allow' && d.ruleId).toBe('script-clean-allow-desktop')
  })

  it('confirmMode={diff} 时评估器不命中，按默认 write 走确认', () => {
    const d = decide(
      mkFacts('write_file', 'write', [], 'medium'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps({
        config: { confirmMode: 'diff' },
        autoEvaluator: () => ({ approve: true, reason: '不该被调用' })
      })
    )
    expect(d.type).toBe('require-confirm')
  })

  it('首条匹配的 auto 规则评估器不批准时继续评估后续 auto 规则（M3）', () => {
    const rules = [
      {
        id: 'auto-1',
        when: 'invocation',
        match: { lane: ['desktop'], toolName: ['write_file'] },
        action: 'auto-evaluator',
        reason: 'r1'
      },
      {
        id: 'auto-2',
        when: 'invocation',
        match: { lane: ['desktop'], toolName: ['write_file'] },
        action: 'auto-evaluator',
        reason: 'r2'
      }
    ]
    let calls = 0
    const d = decide(
      mkFacts('write_file', 'write', [], 'medium'),
      mkContext('desktop'),
      rules,
      deps({
        config: { confirmMode: 'auto' },
        autoEvaluator: () => {
          calls++
          return calls === 1 ? { approve: false, reason: '信息不足' } : { approve: true, reason: '低风险' }
        }
      })
    )
    expect(calls).toBe(2)
    expect(d.type === 'auto-allow' && d.ruleId).toBe('auto-2')
  })
})

describe('decide：远程写 grant 消费', () => {
  it('未注入 grant 余量 → 不误放行（回落到确认）', () => {
    const d = decide(
      mkFacts('write_file', 'write', [], 'medium'),
      mkContext('wechat'),
      DEFAULT_POLICY_RULES,
      deps({ config: {}, migrationComplete: true })
    )
    expect(d.type).toBe('require-confirm')
  })

  it('grant 有效（ops>0 且 bytes>0）→ 远程写免确认（remote-write-grant-allow 先于 im-write-ask）', () => {
    const d = decide(
      mkFacts('write_file', 'write', [], 'medium'),
      mkContext('wechat', { remainingOps: 3, remainingBytes: 100 }),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('auto-allow')
    expect(d.type === 'auto-allow' && d.ruleId).toBe('remote-write-grant-allow')
  })

  it('grant ops=0（操作数耗尽）→ 无效，回落到确认', () => {
    const d = decide(
      mkFacts('write_file', 'write', [], 'medium'),
      mkContext('wechat', { remainingOps: 0, remainingBytes: 100 }),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
  })

  it('grant bytes=0（字节耗尽）→ 无效，回落到确认', () => {
    const d = decide(
      mkFacts('write_file', 'write', [], 'medium'),
      mkContext('wechat', { remainingOps: 3, remainingBytes: 0 }),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
  })
})

describe('decide：安全不变量（硬约束先于缓存）+ 默认兜底', () => {
  it('危险信号（script-analysis dangerous）在缓存查询之前被硬拒绝', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [
        { kind: 'script-analysis', signal: 'dangerous', patterns: ['rm -rf'] }
      ], 'high'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps({ cache: cacheWith('allow') })
    )
    expect(d.type).toBe('deny')
  })

  it('deniedTools 配置命中的工具被硬拒绝（第 1 步）', () => {
    const d = decide(
      mkFacts('wechat_send', 'outbound', [], 'medium'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps({ config: { deniedTools: ['wechat_send'] } })
    )
    expect(d.type).toBe('deny')
  })
})

describe('decide：extraction-failed 一律问用户', () => {
  it('即使 read 工具，提取失败也走确认', () => {
    const d = decide(
      mkFacts('read_file', 'read', [{ kind: 'extraction-failed', reason: '无法解析' }], 'low'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
  })
})

describe('decideIngress：消息入口准入', () => {
  it('飞书群聊默认拒绝', () => {
    const r = decideIngress({ lane: 'feishu', origin: { kind: 'group' } }, DEFAULT_POLICY_RULES)
    expect(r.action).toBe('deny')
    expect(r.ruleId).toBe('ingress-feishu-group-deny')
  })

  it('白名单内单聊（direct-owner）默认放行', () => {
    const r = decideIngress({ lane: 'wechat', origin: { kind: 'direct-owner', senderId: 'u1' } }, DEFAULT_POLICY_RULES)
    expect(r.action).toBe('allow')
  })

  it('数组顺序首条命中即返回：allow 条目先于同域 deny 时会掩盖 deny（依赖顺序自律）', () => {
    const rules = [
      { id: 'allow-any', when: 'ingress', match: { lane: ['feishu'] }, action: 'allow', reason: 'r' },
      { id: 'deny-group', when: 'ingress', match: { lane: ['feishu'], origin: 'group' }, action: 'deny', reason: 'r' }
    ]
    const r = decideIngress({ lane: 'feishu', origin: { kind: 'group' } }, rules)
    expect(r.ruleId).toBe('allow-any')
    expect(r.action).toBe('allow')
  })
})

describe('buildMemoryTiers：run_script 记忆封顶（§5.3）', () => {
  it('携带 script-network 信号的调用强制"仅此一次"，不开放记忆档位', () => {
    const facts = mkFacts('run_script', 'execute', [
      { kind: 'script-analysis', signal: 'clean', patterns: [] },
      { kind: 'script-network', patterns: ['https://example.com'] },
      // 同时携带可派生缓存键的 path-target 信号：封顶必须压过它，"记住路径"不得绕过网络确认
      { kind: 'path-target', path: 'out/report.txt', zone: 'workdir-normal' }
    ], 'high')
    expect(buildMemoryTiers(facts)).toEqual([])
  })

  it('携带 script-uncertified 信号的调用强制"仅此一次"，不开放记忆档位', () => {
    const facts = mkFacts('run_script', 'execute', [
      { kind: 'script-analysis', signal: 'clean', patterns: [] },
      { kind: 'script-uncertified' },
      { kind: 'path-target', path: 'out/report.txt', zone: 'workdir-normal' }
    ], 'high')
    expect(buildMemoryTiers(facts)).toEqual([])
  })

  it('普通脚本（无网络/未认证信号）不受影响', () => {
    const facts = mkFacts('run_shell', 'execute', [
      {
        kind: 'command-sequence',
        commands: [{ verb: 'ls', signature: 'ls', args: [] }],
        persistable: true
      }
    ], 'high')
    expect(buildMemoryTiers(facts).length).toBeGreaterThan(0)
  })
})
