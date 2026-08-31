import { describe, expect, it } from 'vitest'
import { recordSettingsChange } from './settingsAudit'
import type { AuditSink } from './channels'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'

function audit(): AuditSink & { events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { events, record: (e) => events.push(e) }
}

describe('settingsAudit（设置变更审计，§5.6-6）', () => {
  it('policy-change 落 settings.policy-change 事件（含新旧值 key）', () => {
    const a = audit()
    recordSettingsChange(a, {
      kind: 'policy-change',
      lane: 'desktop',
      sessionId: 's1',
      key: 'im-write-ask',
      before: 'ask',
      after: 'allow',
      reason: '用户放宽'
    })
    expect(a.events[0]!.event).toBe('settings.policy-change')
    expect(a.events[0]!.cacheKey).toBe('im-write-ask')
    expect(a.events[0]!.reason).toBe('用户放宽')
    expect(a.events[0]!.actor).toBe('user')
  })

  it('tool-toggle 落 settings.tool-toggle 事件', () => {
    const a = audit()
    recordSettingsChange(a, {
      kind: 'tool-toggle',
      lane: 'feishu',
      sessionId: 's2',
      key: 'deniedTools',
      before: [],
      after: ['wechat_send']
    })
    expect(a.events[0]!.event).toBe('settings.tool-toggle')
  })
})
