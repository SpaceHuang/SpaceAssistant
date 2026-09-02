/**
 * 全工具 × 链路 判定矩阵回归（P1 行为等价护栏，§9）。
 *
 * 每个用例固定"迁移前内联判定"的结论，迁移后由策略引擎 + 默认规则承载：
 * 提取器（runExtractors）产事实 → decide() 出 Decision，断言 type / ruleId。
 * EnvFacts / 配置一律字面量注入，不 mock 环境对象。
 */
import { describe, expect, it } from 'vitest'
import { decide, deriveCacheKeys } from '../../src/shared/policy/policyEngine'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { resolvePolicyRules } from '../../src/shared/policy/policyPackages'
import { getBuiltinToolMetadata } from '../../src/shared/builtinToolMetadata'
import { runExtractors } from './extractors/runExtractors'
import { BROWSER_REMOTE_DISABLED_CODE } from '../../src/shared/browserRemotePolicy'
import { SHELL_REMOTE_DISABLED_ERROR } from '../../src/shared/shellToolDisplay'
import type {
  ContentFacts,
  DecisionCacheEntry,
  DecisionCacheView,
  EnvFacts,
  ExecutionContext,
  CacheKey,
  PolicyEngineDeps
} from '../../src/shared/confirmation/types'

const ENV: EnvFacts = { os: 'win32', workDir: 'E:/work', sensitivePaths: ['C:/Users/x/.ssh'] }

/** 内存缓存视图（测试用）：按 canonical key json 精确匹配。 */
function mapCache(entries: DecisionCacheEntry[]): DecisionCacheView {
  const m = new Map<string, DecisionCacheEntry>()
  for (const e of entries) m.set(JSON.stringify(e.key), e)
  return { lookup: (key: CacheKey) => m.get(JSON.stringify(key)) ?? null }
}

function allowEntry(key: CacheKey, scope: 'session' | 'persistent' = 'persistent'): DecisionCacheEntry {
  return {
    id: 't',
    key,
    decision: 'allow',
    lane: '*',
    scope,
    createdAt: 1,
    lastHitAt: 1,
    hitCount: 0,
    source: 'user-confirm'
  }
}

function ctx(lane: ExecutionContext['lane'], extra?: Partial<ExecutionContext>): ExecutionContext {
  return { lane, origin: { kind: 'direct-owner' }, sessionId: 's1', ...extra }
}

function deps(config: Record<string, unknown> = {}, cache: DecisionCacheView = mapCache([]), extra?: Partial<PolicyEngineDeps>): PolicyEngineDeps {
  return { cache, config, migrationComplete: false, ...extra }
}

function factsFor(toolName: string, input: Record<string, unknown>, env: EnvFacts = ENV): ContentFacts {
  const descriptor = getBuiltinToolMetadata(toolName)
  if (!descriptor) throw new Error(`no metadata for ${toolName}`)
  return runExtractors(descriptor, input, env)
}

function decideToolCall(
  toolName: string,
  input: Record<string, unknown>,
  lane: ExecutionContext['lane'],
  d: PolicyEngineDeps,
  contextExtra?: Partial<ExecutionContext>,
  env: EnvFacts = ENV
) {
  return decide(factsFor(toolName, input, env), ctx(lane, contextExtra), DEFAULT_POLICY_RULES, d)
}

describe('判定矩阵：run_shell', () => {
  const input = { command: 'ls -la' }
  it('远程链路硬拒（SHELL_REMOTE_DISABLED_ERROR）', () => {
    const d = decideToolCall('run_shell', input, 'wechat', deps())
    expect(d.type).toBe('deny')
    expect(d.ruleId).toBe('remote-shell-disabled')
    expect(d.type === 'deny' && d.reason).toBe(SHELL_REMOTE_DISABLED_ERROR)
  })
  it('桌面无信任 → 确认（默认表 execute）', () => {
    const d = decideToolCall('run_shell', input, 'desktop', deps())
    expect(d.type).toBe('require-confirm')
  })
  it('桌面命中信任缓存（exact 档）→ 放行', () => {
    const cache = mapCache([allowEntry({ kind: 'shell-command', verb: 'ls -la', level: 'exact' })])
    const d = decideToolCall('run_shell', input, 'desktop', deps({}, cache))
    expect(d.type).toBe('auto-allow')
    expect(d.ruleId).toBe('cache-hit')
  })
  it('桌面预检评估器放行（信任/安全命令）→ 放行', () => {
    const d = decideToolCall('run_shell', input, 'desktop', deps({}, mapCache([]), {
      autoEvaluator: () => ({ approve: true, reason: 'skip' })
    }))
    expect(d.type).toBe('auto-allow')
    expect(d.ruleId).toBe('shell-precheck-auto-allow')
  })
  it('评估器不裁决 → 交还规则链（确认）', () => {
    const d = decideToolCall('run_shell', input, 'desktop', deps({}, mapCache([]), {
      autoEvaluator: () => ({ approve: false, reason: 'no' })
    }))
    expect(d.type).toBe('require-confirm')
  })
  it('deniedTools 硬拒先于缓存命中（安全不变量）', () => {
    const cache = mapCache([allowEntry({ kind: 'shell-command', verb: 'ls -la', level: 'exact' })])
    const d = decideToolCall('run_shell', input, 'desktop', deps({ deniedTools: ['run_shell'] }, cache))
    expect(d.type).toBe('deny')
    expect(d.ruleId).toBe('denied-tools')
  })
  it('变体绕过：FOO=1 前缀 / cd && 复合命令不命中 exact 缓存', () => {
    const cache = mapCache([allowEntry({ kind: 'shell-command', verb: 'ls -la', level: 'exact' })])
    for (const command of ['FOO=1 ls -la', 'cd x && ls -la', 'ls   -la']) {
      const facts = factsFor('run_shell', { command })
      const keys = deriveCacheKeys(facts, 's1')
      // 复合/带元语法命令不派生可持久化键；空白变体规范化后命中是允许的同命令等价
      if (command === 'ls   -la') {
        expect(keys.some((k) => k.kind === 'shell-command' && k.verb === 'ls -la')).toBe(true)
      } else {
        expect(keys.length).toBe(0)
      }
    }
  })
})

describe('判定矩阵：browser', () => {
  it('桌面 navigate(open) 未信任域名 → 确认', () => {
    const d = decideToolCall('browser', { action: 'navigate', url: 'https://a.com' }, 'desktop', deps())
    expect(d.type).toBe('require-confirm')
    expect(d.ruleId).toBe('browser-navigate-ask-desktop')
  })
  it('桌面 navigate + navigateRequiresConfirm=false → 放行', () => {
    const d = decideToolCall('browser', { action: 'navigate', url: 'https://a.com' }, 'desktop', deps({ navigateRequiresConfirm: false }))
    expect(d.type).toBe('auto-allow')
  })
  it('桌面 navigate 命中持久域名信任 → 放行', () => {
    const cache = mapCache([allowEntry({ kind: 'domain', domain: 'a.com', level: 'domain-any-action' })])
    const d = decideToolCall('browser', { action: 'navigate', url: 'https://a.com' }, 'desktop', deps({}, cache))
    expect(d.type).toBe('auto-allow')
    expect(d.ruleId).toBe('cache-hit')
  })
  it('桌面 navigate 命中会话级信任（sessionId 绑定）→ 放行；其他会话不命中', () => {
    const cache = mapCache([
      allowEntry({ kind: 'domain', domain: 'a.com', level: 'domain-any-action', sessionId: 's1' }, 'session')
    ])
    expect(decideToolCall('browser', { action: 'navigate', url: 'https://a.com' }, 'desktop', deps({}, cache)).type).toBe('auto-allow')
    // 另一个会话：sessionId 不同 → 不命中
    const d2 = decide(
      factsFor('browser', { action: 'navigate', url: 'https://a.com' }),
      ctx('desktop', { sessionId: 's2' }),
      DEFAULT_POLICY_RULES,
      deps({}, cache)
    )
    expect(d2.type).toBe('require-confirm')
  })
  it('navigate 非 open 模式 → 放行（现状免确认）', () => {
    const d = decideToolCall('browser', { action: 'navigate', url: 'https://a.com', mode: 'reuse' }, 'desktop', deps())
    expect(d.type).toBe('auto-allow')
  })
  it('桌面 act 无当前页域名 → 确认', () => {
    const d = decideToolCall('browser', { action: 'act', instruction: 'click' }, 'desktop', deps({ actRequiresConfirm: true }))
    expect(d.type).toBe('require-confirm')
    expect(d.ruleId).toBe('browser-act-ask-desktop')
  })
  it('桌面 act 命中 act 域名信任（domain+action 档）→ 放行', () => {
    const cache = mapCache([allowEntry({ kind: 'domain', domain: 'a.com', level: 'domain+action' })])
    const env: EnvFacts = { ...ENV, browserAct: { currentHost: 'a.com' } }
    const d = decideToolCall('browser', { action: 'act', instruction: 'click' }, 'desktop', deps({ actRequiresConfirm: true }, cache), undefined, env)
    expect(d.type).toBe('auto-allow')
  })
  it('act 不消费 navigate 信任档（trustedDomains ≠ actTrustedDomains，档位隔离）', () => {
    const cache = mapCache([allowEntry({ kind: 'domain', domain: 'a.com', level: 'domain-any-action' })])
    const env: EnvFacts = { ...ENV, browserAct: { currentHost: 'a.com' } }
    const d = decideToolCall('browser', { action: 'act', instruction: 'click' }, 'desktop', deps({ actRequiresConfirm: true }, cache), undefined, env)
    expect(d.type).toBe('require-confirm')
  })
  it('act 高危 → 确认（映射 suspicious，不升级为拒绝；信任不生效）', () => {
    const cache = mapCache([allowEntry({ kind: 'domain', domain: 'a.com', level: 'domain+action' })])
    const env: EnvFacts = { ...ENV, browserAct: { currentHost: 'a.com', dangerous: true } }
    const d = decideToolCall('browser', { action: 'act', instruction: 'pay' }, 'desktop', deps({ actRequiresConfirm: true }, cache), undefined, env)
    expect(d.type).toBe('require-confirm')
    expect(d.ruleId).toBe('browser-act-danger-ask')
  })
  it('actRequiresConfirm=false → 放行（桌面/远程同一开关）', () => {
    for (const lane of ['desktop', 'wechat'] as const) {
      const d = decideToolCall('browser', { action: 'act', instruction: 'x' }, lane, deps({ actRequiresConfirm: false }))
      expect(d.type).toBe('auto-allow')
      expect(d.ruleId).toBe('browser-act-allow-unconfigured')
    }
  })
  it('远程 navigate 默认免确认（remoteNavigateRequiresConfirm=false）', () => {
    const d = decideToolCall('browser', { action: 'navigate', url: 'https://a.com' }, 'feishu', deps({ navigateRequiresConfirm: true, remoteNavigateRequiresConfirm: false }))
    expect(d.type).toBe('auto-allow')
  })
  it('远程 navigate 双开关均要求 → 确认；仅桌面要求 → 放行', () => {
    const input = { action: 'navigate', url: 'https://a.com' }
    expect(decideToolCall('browser', input, 'feishu', deps({ navigateRequiresConfirm: true, remoteNavigateRequiresConfirm: true })).type).toBe('require-confirm')
    expect(decideToolCall('browser', input, 'feishu', deps({ navigateRequiresConfirm: false, remoteNavigateRequiresConfirm: true })).type).toBe('auto-allow')
  })
  it('远程 act 默认确认；迁移完成且开关关闭 → 放行；高危仍确认', () => {
    expect(decideToolCall('browser', { action: 'act', instruction: 'x' }, 'wechat', deps({ actRequiresConfirm: true, remoteActSkipConfirm: false })).type).toBe('require-confirm')
    expect(decideToolCall('browser', { action: 'act', instruction: 'x' }, 'wechat', deps({ actRequiresConfirm: true, remoteActSkipConfirm: true })).type).toBe('auto-allow')
    const env: EnvFacts = { ...ENV, browserAct: { dangerous: true } }
    const d = decideToolCall('browser', { action: 'act', instruction: 'x' }, 'wechat', deps({ actRequiresConfirm: true, remoteActSkipConfirm: true }), undefined, env)
    expect(d.type).toBe('require-confirm')
    expect(d.ruleId).toBe('browser-act-danger-ask')
  })
  it('远程浏览器未开放（allowRemoteSessions=false）→ 硬拒', () => {
    const d = decideToolCall('browser', { action: 'navigate', url: 'https://a.com' }, 'feishu', deps({ allowRemoteSessions: false, navigateRequiresConfirm: true, remoteNavigateRequiresConfirm: false }))
    expect(d.type).toBe('deny')
    expect(d.ruleId).toBe('remote-browser-disabled')
    expect(d.type === 'deny' && d.reason).toBe(BROWSER_REMOTE_DISABLED_CODE)
  })
})

describe('判定矩阵：run_lark_cli', () => {
  it('读类子命令 → 放行（双链路）', () => {
    for (const lane of ['desktop', 'feishu'] as const) {
      const d = decideToolCall('run_lark_cli', { args: ['calendar', 'event', 'list'] }, lane, deps({ larkCliWriteRequiresConfirm: true }))
      expect(d.type).toBe('auto-allow')
      expect(d.ruleId).toBe('lark-read-allow')
    }
  })
  it('写类按开关：larkCliWriteRequiresConfirm=true → 确认；false → 放行', () => {
    const input = { args: ['doc', 'create'] }
    expect(decideToolCall('run_lark_cli', input, 'desktop', deps({ larkCliWriteRequiresConfirm: true })).type).toBe('require-confirm')
    expect(decideToolCall('run_lark_cli', input, 'desktop', deps({ larkCliWriteRequiresConfirm: false })).type).toBe('auto-allow')
  })
  it('high_impact / unknown 无条件确认（不消费开关）', () => {
    for (const input of [{ args: ['message', 'send', '--chat-type', 'group'] }, { args: [] }, {}]) {
      const d = decideToolCall('run_lark_cli', input, 'desktop', deps({ larkCliWriteRequiresConfirm: false }))
      expect(d.type).toBe('require-confirm')
    }
  })
  it('飞书 remoteDenyOutbound + 写类 → 硬拒；读类放行', () => {
    const cfg = { remoteDenyOutbound: true, larkCliWriteRequiresConfirm: true }
    const d = decideToolCall('run_lark_cli', { args: ['doc', 'create'] }, 'feishu', deps(cfg))
    expect(d.type).toBe('deny')
    expect(d.ruleId).toBe('remote-deny-lark-write-outbound')
    expect(d.type === 'deny' && d.reason).toBe('远程策略禁止此类写操作。')
    expect(decideToolCall('run_lark_cli', { args: ['doc', 'get'] }, 'feishu', deps(cfg)).type).toBe('auto-allow')
  })
  it('出站预算耗尽：写类 → 预算暂停 deny；读类不受影响', () => {
    const d = decideToolCall('run_lark_cli', { args: ['doc', 'create'] }, 'feishu', deps({ larkCliWriteRequiresConfirm: true }), { outboundWriteBudgetRemaining: 0 })
    expect(d.type).toBe('deny')
    expect(d.ruleId).toBe('remote-outbound-budget-pause-lark')
    const d2 = decideToolCall('run_lark_cli', { args: ['doc', 'get'] }, 'feishu', deps({ larkCliWriteRequiresConfirm: true }), { outboundWriteBudgetRemaining: 0 })
    expect(d2.type).toBe('auto-allow')
  })
  it('远程阻断先于预算暂停（现状 :878 先于 :929）', () => {
    const d = decideToolCall('run_lark_cli', { args: ['doc', 'create'] }, 'feishu', deps({ remoteDenyOutbound: true, larkCliWriteRequiresConfirm: true }), { outboundWriteBudgetRemaining: 0 })
    expect(d.type).toBe('deny')
    expect(d.ruleId).toBe('remote-deny-lark-write-outbound')
  })
})

describe('判定矩阵：wechat_send / wechat_reply', () => {
  it('桌面/远程默认免确认（outbound 默认放行）', () => {
    for (const lane of ['desktop', 'wechat'] as const) {
      expect(decideToolCall('wechat_send', { userId: 'u', text: 't' }, lane, deps()).type).toBe('auto-allow')
      expect(decideToolCall('wechat_reply', { text: 't' }, lane, deps()).type).toBe('auto-allow')
    }
  })
  it('微信 remoteDenyOutbound → 硬拒', () => {
    const d = decideToolCall('wechat_send', { userId: 'u', text: 't' }, 'wechat', deps({ remoteDenyOutbound: true }))
    expect(d.type).toBe('deny')
    expect(d.ruleId).toBe('remote-deny-wechat-outbound')
  })
  it('出站预算耗尽 → 预算暂停 deny', () => {
    const d = decideToolCall('wechat_send', { userId: 'u', text: 't' }, 'wechat', deps(), { outboundWriteBudgetRemaining: 0 })
    expect(d.type).toBe('deny')
    expect(d.ruleId).toBe('remote-outbound-budget-pause-wechat')
  })
})

describe('判定矩阵：MCP 工具', () => {
  // 新模型（R5）：总是产 mcp-tool 信号；注解安全时额外产 mcp-readonly，actionClass 降 read。
  function mcpFacts(serverId: string, toolName: string, readonlySafe: boolean): ContentFacts {
    return {
      toolName: `mcp_${serverId}_${toolName}`,
      actionClass: readonlySafe ? 'read' : 'write',
      baseRiskLevel: 'medium',
      signals: [
        { kind: 'mcp-tool', serverId, toolName },
        ...(readonlySafe ? [{ kind: 'mcp-readonly' as const, serverId, toolName }] : [])
      ],
      summary: { text: `mcp ${serverId}/${toolName}` }
    }
  }
  it('无安全注解 → 确认（mcp-tool-ask）', () => {
    const d = decide(mcpFacts('srv', 'tool', false), ctx('desktop'), DEFAULT_POLICY_RULES, deps())
    expect(d.type).toBe('require-confirm')
    expect(d.ruleId).toBe('mcp-tool-ask')
  })
  it('安全注解（mcp-readonly 信号）→ 命中 mcp-readonly-allow 放行（先于 mcp-tool-ask）', () => {
    const d = decide(mcpFacts('srv', 'tool', true), ctx('desktop'), DEFAULT_POLICY_RULES, deps())
    expect(d.type).toBe('auto-allow')
    expect(d.ruleId).toBe('mcp-readonly-allow')
  })
  it('strict 套餐：mcp-readonly-allow 上调为 ask → 安全注解工具转询问', () => {
    const strictRules = resolvePolicyRules({
      lane: 'desktop',
      packages: { desktop: 'strict' },
      rules: DEFAULT_POLICY_RULES
    })
    const d = decide(mcpFacts('srv', 'tool', true), ctx('desktop'), strictRules, deps())
    expect(d.type).toBe('require-confirm')
    expect(d.ruleId).toBe('mcp-readonly-allow')
  })
  it('会话信任（sessionId 绑定）→ 放行；其他会话/其他工具不命中', () => {
    const cache = mapCache([
      allowEntry({ kind: 'mcp-tool', serverId: 'srv', toolName: 'tool', sessionId: 's1' }, 'session')
    ])
    expect(decide(mcpFacts('srv', 'tool', false), ctx('desktop'), DEFAULT_POLICY_RULES, deps({}, cache)).type).toBe('auto-allow')
    expect(
      decide(mcpFacts('srv', 'tool', false), ctx('desktop', { sessionId: 's2' }), DEFAULT_POLICY_RULES, deps({}, cache)).type
    ).toBe('require-confirm')
    expect(
      decide(mcpFacts('srv', 'other', false), ctx('desktop'), DEFAULT_POLICY_RULES, deps({}, cache)).type
    ).toBe('require-confirm')
  })
})

describe('判定矩阵：write_file / edit_file', () => {
  const input = { path: 'src/a.ts', content: 'x' }
  it('桌面默认 → 确认', () => {
    const d = decideToolCall('write_file', input, 'desktop', deps({ confirmMode: 'diff' }))
    expect(d.type).toBe('require-confirm')
  })
  it('桌面 confirmMode=auto + 评估器批准 → 放行；不裁决 → 确认', () => {
    const approved = decideToolCall('write_file', input, 'desktop', deps({ confirmMode: 'auto' }, mapCache([]), {
      autoEvaluator: () => ({ approve: true, reason: 'ok' })
    }))
    expect(approved.type).toBe('auto-allow')
    expect(approved.ruleId).toBe('desktop-auto-approve')
    const declined = decideToolCall('write_file', input, 'desktop', deps({ confirmMode: 'auto' }, mapCache([]), {
      autoEvaluator: () => ({ approve: false, reason: 'no' })
    }))
    expect(declined.type).toBe('require-confirm')
  })
  it('桌面命中路径缓存 → 放行', () => {
    const cache = mapCache([allowEntry({ kind: 'path', path: 'src/a.ts', level: 'file' })])
    const d = decideToolCall('write_file', input, 'desktop', deps({ confirmMode: 'diff' }, cache))
    expect(d.type).toBe('auto-allow')
    expect(d.ruleId).toBe('cache-hit')
  })
  it('远程写默认确认（im-write-ask）；会话写信任（remote-write 缓存）→ 免确认（cache-hit）', () => {
    const ask = decideToolCall('write_file', input, 'feishu', deps())
    expect(ask.type).toBe('require-confirm')
    if (ask.type === 'require-confirm') expect(ask.ruleId).toBe('im-write-ask')
    const trusted = decideToolCall(
      'write_file',
      input,
      'feishu',
      deps({}, mapCache([allowEntry({ kind: 'remote-write', sessionId: 's1' }, 'session')]))
    )
    expect(trusted.type).toBe('auto-allow')
    if (trusted.type === 'auto-allow') expect(trusted.ruleId).toBe('cache-hit')
  })
  it('远程写不命中桌面 auto 审批（lane 隔离）', () => {
    const d = decideToolCall('write_file', input, 'feishu', deps({ confirmMode: 'auto' }, mapCache([]), {
      autoEvaluator: () => ({ approve: true, reason: 'ok' })
    }))
    expect(d.type).toBe('require-confirm')
  })
})

describe('判定矩阵：read 类工具与脚本规则不受波及', () => {
  it('read_file 等读类工具全链路免确认', () => {
    for (const lane of ['desktop', 'wechat', 'feishu'] as const) {
      expect(decideToolCall('read_file', { path: 'a.ts' }, lane, deps()).type).toBe('auto-allow')
    }
  })
  it('脚本 lane 分叉保持：网络脚本桌面问、远程拒', () => {
    const code = 'import requests\nrequests.get("https://x.com")'
    const desktop = decideToolCall('run_script', { code }, 'desktop', deps())
    expect(desktop.type).toBe('require-confirm')
    const remote = decideToolCall('run_script', { code }, 'wechat', deps())
    expect(remote.type).toBe('deny')
    expect(remote.ruleId).toBe('script-network-deny-remote')
  })
})
