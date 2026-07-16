import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import { DEFAULT_WECHAT_CONFIG } from '../src/shared/wechatTypes'
import { filterBuiltinToolsForApi } from './toolsConfigRuntime'
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
