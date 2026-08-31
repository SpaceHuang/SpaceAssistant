import { describe, expect, it } from 'vitest'
import { ImChannel } from './imChannel'
import { createImRequestToolConfirm } from './imBridge'
import type { ConfirmRequest, MemoryTier } from '../../src/shared/confirmation/types'
import type { RemoteConfirmPayload } from '../tools/types'

const payload: RemoteConfirmPayload = {
  sessionId: 's1',
  toolCallId: 'tool-1',
  toolName: 'run_shell',
  toolInput: { command: 'ping baidu.com' },
  messageId: 'm1',
  trustEligible: true
}

function confirmRequest(tiers: MemoryTier[] = []): ConfirmRequest {
  return {
    facts: {
      toolName: 'run_shell',
      actionClass: 'execute',
      baseRiskLevel: 'high',
      signals: [],
      summary: { text: '命令序列：ping baidu.com' }
    },
    riskLevel: 'high',
    memoryTiers: tiers,
    timeoutMs: null
  }
}

describe('createImRequestToolConfirm（§5.4 桥接工厂）', () => {
  it('ImChannel+入站批准 → requestToolConfirm 返回 y', async () => {
    const ch = new ImChannel({ lane: 'wechat', timeoutMs: 1000, sendPrompt: () => undefined })
    const requestToolConfirm = createImRequestToolConfirm({
      imChannel: ch,
      buildConfirmRequest: () => confirmRequest(),
      buildPending: (p) => ({
        sessionId: p.sessionId,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        toolInput: p.toolInput,
        messageId: p.messageId,
        matchKey: 'u1',
        trustEligible: p.trustEligible
      })
    })
    const promise = requestToolConfirm(payload)
    // 入站批准
    ch.tryResolveFromInbound({ kind: 'approve', confirmId: ch.listPending()[0]!.confirmId }, { matchKey: 'u1', messageId: 'm2' })
    await expect(promise).resolves.toBe('y')
  })

  it('入站拒绝 → requestToolConfirm 返回 n', async () => {
    const ch = new ImChannel({ lane: 'feishu', timeoutMs: 1000, sendPrompt: () => undefined })
    const requestToolConfirm = createImRequestToolConfirm({
      imChannel: ch,
      buildConfirmRequest: () => confirmRequest(),
      buildPending: (p) => ({ sessionId: p.sessionId, toolName: p.toolName, messageId: p.messageId, matchKey: 'c1' })
    })
    const promise = requestToolConfirm(payload)
    ch.tryResolveFromInbound({ kind: 'reject', confirmId: ch.listPending()[0]!.confirmId }, { matchKey: 'c1', messageId: 'm2' })
    await expect(promise).resolves.toBe('n')
  })
})
