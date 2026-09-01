import { describe, expect, it } from 'vitest'
import { evaluateToolCallGate, type ToolCallGateArgs } from './confirmation/toolCallGate'
import { DEFAULT_WECHAT_CONFIG, type WeChatConfig } from '../src/shared/wechatTypes'
import { DEFAULT_TOOLS_CONFIG, type ToolsConfig } from '../src/shared/domainTypes'
import type { RemoteContext } from './tools/types'

function wechatCtx(
  confirmPolicy: WeChatConfig['remoteConfirmPolicy'] = 'always'
): RemoteContext {
  return {
    source: 'wechat',
    messageId: 'm1',
    userId: 'u1',
    contextToken: 'c',
    confirmPolicy
  }
}

const toolsConfig: ToolsConfig = { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] }

function gate(
  toolName: string,
  toolInput: Record<string, unknown>,
  overrides: Partial<ToolCallGateArgs> = {}
) {
  return evaluateToolCallGate({
    toolName,
    toolInput,
    sessionId: 's1',
    workDir: '/tmp/wd',
    userDataDir: '/tmp/ud',
    toolsConfig,
    audit: { record: () => undefined },
    ...overrides
  })
}

describe('wechat outbound confirm removal（经 toolCallGate + 规则表）', () => {
  it('wechat_reply does not need confirmation even when legacy flag is true', async () => {
    const r = await gate('wechat_reply', { text: 'hi' }, { remoteContext: wechatCtx() })
    expect(r.decision.type).toBe('auto-allow')
  })

  it('wechat_send does not need confirmation even when legacy flag is true', async () => {
    const r = await gate(
      'wechat_send',
      { userId: 'u1', text: 'hi' },
      { remoteContext: wechatCtx() }
    )
    expect(r.decision.type).toBe('auto-allow')
  })

  it('remoteDenyOutbound blocks wechat_reply and wechat_send', async () => {
    const cfg = { ...DEFAULT_WECHAT_CONFIG, remoteDenyOutbound: true }
    for (const [name, input] of [
      ['wechat_reply', { text: 'hi' }],
      ['wechat_send', { userId: 'u1', text: 'hi' }]
    ] as const) {
      const r = await gate(name, input, { remoteContext: wechatCtx(), wechatConfig: cfg })
      expect(r.decision).toMatchObject({ type: 'deny', ruleId: 'remote-deny-wechat-outbound' })
      expect(r.decision.type === 'deny' && r.decision.reason).toBe('远程策略禁止此类写操作。')
    }
  })

  it('legacy remote_read_only policy alone no longer blocks outbound without deny flag', async () => {
    const r = await gate(
      'wechat_reply',
      { text: 'hi' },
      { remoteContext: wechatCtx('remote_read_only'), wechatConfig: DEFAULT_WECHAT_CONFIG }
    )
    expect(r.decision.type).not.toBe('deny')
  })

  it('always / im_confirm / inherit allow outbound without remote block', async () => {
    for (const policy of ['always', 'im_confirm', 'inherit'] as const) {
      for (const [name, input] of [
        ['wechat_reply', { text: 'hi' }],
        ['wechat_send', { userId: 'u1', text: 'hi' }]
      ] as const) {
        const r = await gate(name, input, {
          remoteContext: wechatCtx(policy),
          wechatConfig: DEFAULT_WECHAT_CONFIG
        })
        expect(r.decision.type).not.toBe('deny')
      }
    }
  })

  it('write_file still needs confirmation under builtin policy without remote context', async () => {
    const r = await gate('write_file', { path: 'a.txt', content: 'x' })
    expect(r.decision.type).toBe('require-confirm')
  })
})
