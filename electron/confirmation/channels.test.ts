import { describe, expect, it } from 'vitest'
import { DesktopChannel, LegacyImChannel } from './channels'
import type { AuditSink } from './channels'
import type { ConfirmRequest, SecurityAuditEvent } from '../../src/shared/confirmation/types'

function req(overrides: Partial<ConfirmRequest> = {}): ConfirmRequest {
  return {
    facts: {
      toolName: 'run_shell',
      actionClass: 'execute',
      baseRiskLevel: 'high',
      signals: [{ kind: 'command-sequence', commands: [{ verb: 'curl', args: [], signature: 'curl x' }] }],
      summary: { text: '命令序列：curl x' }
    },
    riskLevel: 'high',
    memoryTiers: [],
    timeoutMs: null,
    ...overrides
  }
}

function auditSink(): AuditSink & { events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { events, record: (e) => events.push(e) }
}

describe('DesktopChannel', () => {
  it('approved 映射为 {kind:approved}，并落 confirm.request/outcome（同 requestId）', async () => {
    const audit = auditSink()
    const ch = new DesktopChannel({
      requestId: 'req-1',
      toolUseId: 'tool-1',
      sessionId: 's1',
      toolName: 'run_shell',
      lane: 'desktop',
      audit,
      waitForToolConfirm: async () => 'approved'
    })
    const outcome = await ch.request(req())
    expect(outcome).toEqual({ kind: 'approved' })
    const events = audit.events
    expect(events.map((e) => e.event)).toEqual(['confirm.request', 'confirm.outcome'])
    expect(events[0]!.requestId).toBe('req-1')
    expect(events[1]!.requestId).toBe('req-1')
    expect(events[1]!.outcome).toBe('approved')
    expect(events[0]!.factsSummary).toBe('命令序列：curl x')
  })

  it('timeout / rejected 正确映射', async () => {
    const audit = auditSink()
    const ch = new DesktopChannel({
      requestId: 'r',
      toolUseId: 't',
      sessionId: 's',
      toolName: 'run_shell',
      lane: 'desktop',
      audit,
      waitForToolConfirm: async () => 'timeout'
    })
    expect(await ch.request(req())).toEqual({ kind: 'timeout' })
  })
})

describe('LegacyImChannel', () => {
  it("'y'→approved、'n'→rejected、'timeout'→timeout，并落 confirm.* 审计", async () => {
    const audit = auditSink()
    const ch = new LegacyImChannel({
      requestId: 'req-2',
      sessionId: 's2',
      toolName: 'run_shell',
      lane: 'wechat',
      audit,
      send: async () => 'y'
    })
    expect(await ch.request(req())).toEqual({ kind: 'approved' })
    expect(audit.events.map((e) => e.outcome ?? e.event)).toEqual(['confirm.request', 'approved'])

    const ch2 = new LegacyImChannel({
      requestId: 'req-3',
      sessionId: 's2',
      toolName: 'run_shell',
      lane: 'feishu',
      audit,
      send: async () => 'timeout'
    })
    expect(await ch2.request(req())).toEqual({ kind: 'timeout' })
    expect(audit.events.at(-1)!.event).toBe('confirm.outcome')
    expect(audit.events.at(-1)!.outcome).toBe('timeout')
  })
})
