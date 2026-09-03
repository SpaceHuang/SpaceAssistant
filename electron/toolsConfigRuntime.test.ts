import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import { DEFAULT_WECHAT_CONFIG } from '../src/shared/wechatTypes'
import { filterBuiltinToolsForApi, exposedToolNamesForLane } from './toolsConfigRuntime'
import type { FeishuRemoteContext, WeChatRemoteContext } from '../tools/types'

describe('filterBuiltinToolsForApi workdir tools', () => {
  const feishuRemoteContext: FeishuRemoteContext = {
    source: 'feishu',
    messageId: 'm1',
    confirmPolicy: 'always'
  }

  it('hides workdir tools for desktop sessions', () => {
    const list = filterBuiltinToolsForApi(DEFAULT_TOOLS_CONFIG, null, null, null)
    const names = list.map((t) => t.name)
    expect(names).not.toContain('list_work_dirs')
    expect(names).not.toContain('switch_work_dir')
    expect(names).not.toContain('switch_session')
  })

  it('includes workdir tools for remote sessions', () => {
    const list = filterBuiltinToolsForApi(DEFAULT_TOOLS_CONFIG, null, null, feishuRemoteContext)
    const names = list.map((t) => t.name)
    expect(names).toContain('list_work_dirs')
    expect(names).toContain('switch_work_dir')
    expect(names).toContain('switch_session')
  })

  it('respects deniedTools for remote sessions', () => {
    const cfg = {
      ...DEFAULT_TOOLS_CONFIG,
      deniedTools: [...DEFAULT_TOOLS_CONFIG.deniedTools, 'list_work_dirs', 'switch_work_dir']
    }
    const list = filterBuiltinToolsForApi(cfg, null, null, feishuRemoteContext)
    const names = list.map((t) => t.name)
    expect(names).not.toContain('list_work_dirs')
    expect(names).not.toContain('switch_work_dir')
  })
})

describe('filterBuiltinToolsForApi wechat_send remote filtering', () => {
  const wechatEnabled = { ...DEFAULT_WECHAT_CONFIG, enabled: true }
  const feishuRemoteContext: FeishuRemoteContext = {
    source: 'feishu',
    messageId: 'm1',
    confirmPolicy: 'always'
  }
  const wechatRemoteContext: WeChatRemoteContext = {
    source: 'wechat',
    messageId: 'm1',
    confirmPolicy: 'always'
  }

  it('keeps wechat_send for desktop (no remoteContext)', () => {
    const names = filterBuiltinToolsForApi(DEFAULT_TOOLS_CONFIG, null, null, null, null, wechatEnabled).map(
      (t) => t.name
    )
    expect(names).toContain('wechat_send')
    expect(names).toContain('wechat_reply')
  })

  it('always filters wechat_send for wechat remote regardless of remoteDenyOutbound', () => {
    const names = filterBuiltinToolsForApi(
      DEFAULT_TOOLS_CONFIG,
      null,
      null,
      wechatRemoteContext,
      null,
      { ...wechatEnabled, remoteDenyOutbound: false }
    ).map((t) => t.name)
    expect(names).not.toContain('wechat_send')
    expect(names).toContain('wechat_reply')
  })

  it('also filters wechat_send for feishu remote (unconditional across sources)', () => {
    const names = filterBuiltinToolsForApi(
      DEFAULT_TOOLS_CONFIG,
      null,
      null,
      feishuRemoteContext,
      null,
      wechatEnabled
    ).map((t) => t.name)
    expect(names).not.toContain('wechat_send')
    expect(names).toContain('wechat_reply')
  })
})

describe('exposedToolNamesForLane（IPC 下发清单求值）', () => {
  const wechatEnabled = { ...DEFAULT_WECHAT_CONFIG, enabled: true }

  it('desktop 链路包含 read/write/run_shell/browser，排除 workdir 与 wechat_send 的 exposure 限制', () => {
    const cfg = { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] }
    const names = exposedToolNamesForLane('desktop', cfg, null, null, { enabled: true }, wechatEnabled)
    expect(names).toContain('write_file')
    expect(names).toContain('run_shell')
    expect(names).not.toContain('list_work_dirs')
    expect(names).toContain('wechat_send') // desktop 不受 im-no-wechat-send exposure 限制
  })

  it('wechat 链路包含 workdir 工具但排除 wechat_send（exposure 规则 + 远程过滤）', () => {
    const names = exposedToolNamesForLane('wechat', DEFAULT_TOOLS_CONFIG, null, null, null, wechatEnabled)
    expect(names).toContain('list_work_dirs')
    expect(names).not.toContain('wechat_send')
  })

  it('feishu 链路同样排除 wechat_send', () => {
    const names = exposedToolNamesForLane('feishu', DEFAULT_TOOLS_CONFIG, null, null, null, wechatEnabled)
    expect(names).not.toContain('wechat_send')
  })
})

describe('policy.deny-exposure 审计（§5.6 发射点）', () => {
  function fakeAudit() {
    const events: Array<Record<string, unknown>> = []
    return { events, record: (e: Record<string, unknown>) => events.push(e) }
  }

  const denyReadFileRule = {
    id: 'test-deny-read-file',
    when: 'exposure' as const,
    match: { lane: ['desktop' as const], toolName: 'read_file' },
    action: 'deny' as const,
    reason: '测试规则：拒绝暴露 read_file'
  }

  it('策略规则过滤的条目落 policy.deny-exposure（含 ruleId/reason/lane）', () => {
    const audit = fakeAudit()
    const names = exposedToolNamesForLane(
      'desktop',
      DEFAULT_TOOLS_CONFIG,
      null,
      null,
      null,
      null,
      audit,
      [denyReadFileRule]
    )
    expect(names).not.toContain('read_file')
    expect(audit.events).toHaveLength(1)
    expect(audit.events[0]).toMatchObject({
      event: 'policy.deny-exposure',
      lane: 'desktop',
      toolName: 'read_file',
      decision: 'deny',
      ruleId: 'test-deny-read-file',
      reason: '测试规则：拒绝暴露 read_file',
      actor: 'system'
    })
  })

  it('普通开关过滤（deniedTools/shell 未启用）不落 policy.deny-exposure', () => {
    const audit = fakeAudit()
    const names = exposedToolNamesForLane(
      'desktop',
      { ...DEFAULT_TOOLS_CONFIG, deniedTools: ['write_file'] },
      null,
      null,
      null,
      null,
      audit,
      [denyReadFileRule]
    )
    expect(names).not.toContain('write_file')
    // 仅 read_file 被策略规则过滤；write_file 属普通开关过滤不记
    expect(audit.events).toHaveLength(1)
    expect(audit.events[0]!.toolName).toBe('read_file')
  })
})
