import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  auditEntryToLoggerPayload,
  recordSessionSwitchDenied,
  recordSessionSwitchSuccess
} from './remoteSessionSwitchAudit'
import type { FeishuRemoteContext } from '../tools/types'

const feishuCliEvents: Array<{ level: string; event: string }> = []
vi.mock('../feishu/feishuCliLogger', () => ({
  logFeishuCliEvent: (level: string, event: string) => {
    feishuCliEvents.push({ level, event })
  }
}))
vi.mock('../wechat/weChatCliLogger', () => ({
  logWeChatCliEvent: () => undefined
}))
vi.mock('../agentLogger/agentLogger', () => ({
  logAgentEvent: () => undefined
}))

describe('remoteSessionSwitchAudit', () => {
  afterEach(() => {
    feishuCliEvents.length = 0
  })

  function feishuCtx(audit: unknown[] = []): FeishuRemoteContext {
    return {
      source: 'feishu',
      messageId: 'm1',
      confirmPolicy: 'always',
      chatId: 'c1',
      appendSessionSwitchAudit: (entry) => {
        audit.push(entry)
      }
    }
  }

  it('maps success audit to logger payload', () => {
    const payload = auditEntryToLoggerPayload({
      kind: 'success',
      channel: 'feishu',
      callerSessionId: 'a',
      targetSessionId: 'b',
      requestId: 'r1',
      desktopSwitched: true,
      viewChanged: true
    })
    expect(payload.type).toBe('session_switch')
    expect(payload.desktopSwitched).toBe(true)
  })

  it('maps denied audit to logger payload', () => {
    const payload = auditEntryToLoggerPayload({
      kind: 'denied',
      channel: 'feishu',
      callerSessionId: 'a',
      targetSessionId: 'b',
      requestId: 'r1',
      reason: 'guard',
      code: 'caller_busy',
      blockers: ['tool_in_flight'],
      error: 'busy'
    })
    expect(payload.type).toBe('session_switch_denied')
    expect(payload.blockers).toEqual(['tool_in_flight'])
  })

  it('recordSessionSwitchSuccess writes audit and CLI', () => {
    const audit: unknown[] = []
    recordSessionSwitchSuccess(feishuCtx(audit), {
      callerSessionId: 'a',
      targetSessionId: 'b',
      requestId: 'r1',
      desktopSwitched: true,
      viewChanged: false
    })
    expect(audit).toHaveLength(1)
    expect(feishuCliEvents).toEqual([{ level: 'info', event: 'feishu.session.switch' }])
  })

  it('recordSessionSwitchDenied writes audit and CLI for guard', () => {
    const audit: unknown[] = []
    recordSessionSwitchDenied(feishuCtx(audit), {
      callerSessionId: 'a',
      targetSessionId: 'b',
      requestId: 'r1',
      reason: 'guard',
      code: 'caller_busy',
      blockers: ['pending_confirm'],
      error: 'busy caller'
    })
    expect(audit).toHaveLength(1)
    expect(feishuCliEvents).toEqual([{ level: 'warn', event: 'feishu.session.switch_denied' }])
  })
})
