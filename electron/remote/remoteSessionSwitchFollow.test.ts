import { describe, expect, it, vi } from 'vitest'
import {
  adoptRemoteSessionAfterSwitch,
  resolveRemoteOutboundSessionId
} from './remoteSessionSwitchFollow'
import type { FeishuRemoteContext } from '../tools/types'

vi.mock('./remoteSessionActivity', () => ({
  touchRemoteSessionActivity: vi.fn()
}))

describe('remoteSessionSwitchFollow', () => {
  it('resolveRemoteOutboundSessionId prefers remoteContext.outboundSessionId', () => {
    const ctx: FeishuRemoteContext = {
      source: 'feishu',
      messageId: 'm1',
      confirmPolicy: 'always',
      chatId: 'c1',
      outboundSessionId: 'target-id'
    }
    expect(resolveRemoteOutboundSessionId(ctx, 'caller-id')).toBe('target-id')
  })

  it('resolveRemoteOutboundSessionId falls back when context unset', () => {
    expect(resolveRemoteOutboundSessionId(undefined, 'caller-id')).toBe('caller-id')
  })

  it('adoptRemoteSessionAfterSwitch updates remoteContext.outboundSessionId only', () => {
    const ctx: FeishuRemoteContext = {
      source: 'feishu',
      messageId: 'm1',
      confirmPolicy: 'always',
      chatId: 'c1',
      originSessionId: 'caller-id',
      outboundSessionId: 'caller-id'
    }
    adoptRemoteSessionAfterSwitch({
      remoteContext: ctx,
      appDatabase: {} as never,
      targetSessionId: 'target-id'
    })
    expect(ctx.outboundSessionId).toBe('target-id')
    expect(ctx.originSessionId).toBe('caller-id')
  })
})
