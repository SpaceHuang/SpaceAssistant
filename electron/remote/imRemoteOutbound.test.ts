import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSimpleOutboundText,
  maybeTouchOutboundActivity,
  sendImLifecycleMessage,
  sendImOutbound
} from './imRemoteOutbound'
import { touchRemoteSessionActivity } from './remoteSessionActivity'
import { createImLifecycleOutbox } from './imLifecycleOutbox'
import { createMemoryAppDb } from '../database/testHelpers'
import { createHostImOutboundFacts } from '../../src/shared/confirmation/outboundClassification'

vi.mock('./remoteSessionActivity', () => ({
  touchRemoteSessionActivity: vi.fn()
}))

const SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const SUFFIX = '…（完整结果请查看桌面会话）'

describe('buildSimpleOutboundText / sendImOutbound', () => {
  const authorize = (body: string, sessionId: string) => () => createHostImOutboundFacts({ channel: 'wechat', body, sessionId, identityKey: 'owner', ownerId: 'owner', recipient: 'owner', chatType: 'p2p' })
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('appends session suffix and truncates to maxLen', () => {
    const text = buildSimpleOutboundText({
      body: 'x'.repeat(5000),
      sessionId: SESSION_ID,
      maxLen: 4000,
      truncationSuffix: SUFFIX
    })
    expect(text.length).toBeLessThanOrEqual(4000)
    expect(text.endsWith(` 会话#A1B2C3D4`)).toBe(true)
    expect(text).toContain(SUFFIX)
  })

  it('truncates without session suffix when sessionId omitted', () => {
    const text = buildSimpleOutboundText({
      body: 'y'.repeat(100),
      maxLen: 50,
      truncationSuffix: '…cut'
    })
    expect(text.length).toBe(50)
    expect(text.endsWith('…cut')).toBe(true)
  })

  it('applies formatSummary before truncation', () => {
    const text = buildSimpleOutboundText({
      body: 'raw',
      maxLen: 100,
      truncationSuffix: '...',
      formatSummary: (raw) => `SUM:${raw}`
    })
    expect(text).toBe('SUM:raw')
  })

  it('sendImOutbound replies then touches activity', async () => {
    const reply = vi.fn().mockResolvedValue(undefined)
    await sendImOutbound({
      reply,
      body: 'hello',
      sessionId: SESSION_ID,
      maxLen: 4000,
      truncationSuffix: SUFFIX,
      touch: { sessionCommands: {} as never, sessionId: SESSION_ID }
    })
    expect(reply).toHaveBeenCalledWith(expect.stringContaining(` 会话#A1B2C3D4`))
    expect(touchRemoteSessionActivity).toHaveBeenCalledOnce()
  })

  it('maybeTouchOutboundActivity no-ops without sessionId or touch', () => {
    maybeTouchOutboundActivity(undefined, { sessionCommands: {} as never, sessionId: SESSION_ID })
    maybeTouchOutboundActivity(SESSION_ID, undefined)
    expect(touchRemoteSessionActivity).not.toHaveBeenCalled()
  })

  it('sends only the designed lifecycle messages for an IM task', async () => {
    const reply = vi.fn().mockResolvedValue(undefined)
    const stages = [
      { kind: 'accepted', text: '已收到，开始处理。' },
      { kind: 'plan-confirmation', text: '计划：读取并总结文件。请确认或修改计划。' },
      { kind: 'deferred-wait', text: '部分步骤已完成，1 项操作等待你批准。' },
      { kind: 'resumed', text: '已获批准，正在继续。' },
      { kind: 'completed', text: '任务已完成。' },
      { kind: 'failed', text: '任务未能完成，请检查后重试。' }
    ] as const
    for (const stage of stages) {
      const facts = createHostImOutboundFacts({ channel: 'wechat', body: stage.text, sessionId: SESSION_ID, identityKey: 'owner', ownerId: 'owner', recipient: 'owner', chatType: 'p2p' })
      await sendImLifecycleMessage({ reply, stage: stage.kind, text: stage.text, sessionId: SESSION_ID, recipient: 'owner', outboundDeliveryFacts: facts })
    }
    expect(reply.mock.calls.map(([text]) => text)).toEqual(stages.map(({ text }) => text))
  })

  it('binds an ordinary lifecycle reply to the exact current platform message', async () => {
    const reply = vi.fn().mockResolvedValue(undefined)
    const text = 'The requested summary is ready.'
    const destinationId = 'inbound-message-42'
    const facts = createHostImOutboundFacts({ channel: 'feishu', purpose: 'system-reply', body: text,
      sessionId: SESSION_ID, identityKey: 'current-chat', ownerId: 'owner', recipient: 'owner',
      chatType: 'p2p', destinationId })

    await sendImLifecycleMessage({ reply, stage: 'completed', text, sessionId: SESSION_ID,
      recipient: 'owner', destinationId, outboundDeliveryFacts: facts })
    await expect(sendImLifecycleMessage({ reply, stage: 'completed', text, sessionId: SESSION_ID,
      recipient: 'owner', destinationId: 'different-message', outboundDeliveryFacts: facts }))
      .rejects.toThrow('IM_OUTBOUND_FINAL_CHECK_REQUIRED')

    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith(text)
  })

  it.each(['thinking', 'token-delta', 'tool-log', 'call-envelope'] as const)('rejects internal %s content from IM output', async (kind) => {
    const reply = vi.fn().mockResolvedValue(undefined)
    await expect(sendImLifecycleMessage({ reply, stage: kind as never, text: 'internal payload' })).rejects.toThrow('UNSUPPORTED_IM_LIFECYCLE_STAGE')
    expect(reply).not.toHaveBeenCalled()
  })

  it('persists lifecycle output idempotently, leaves failed sends retryable, and reconciles delivery', async () => {
    const db = createMemoryAppDb()
    const sender = createImLifecycleOutbox(db)
    const reply = vi.fn().mockRejectedValueOnce(new Error('temporary send failure')).mockResolvedValue(undefined)
    const event = { eventId: 'event-1', sessionId: 'session-1', stage: 'accepted' as const, text: '已收到，开始处理。' }
    await expect(sender.deliver(event, reply, authorize(event.text, event.sessionId))).rejects.toThrow('temporary send failure')
    expect(sender.listPending('session-1')).toMatchObject([{ eventId: 'event-1', state: 'pending' }])
    await expect(sender.deliver(event, reply, authorize(event.text, event.sessionId))).resolves.toMatchObject({ state: 'delivered' })
    await expect(sender.deliver(event, reply, authorize(event.text, event.sessionId))).resolves.toMatchObject({ state: 'delivered', duplicate: true })
    expect(reply).toHaveBeenCalledTimes(2)
    const reopened = createImLifecycleOutbox(db)
    expect(reopened.get('event-1')).toMatchObject({ state: 'delivered', text: event.text })
    db.close()
  })

  it('does not replay a pending lifecycle message without shared main-process outbound facts', async () => {
    const db = createMemoryAppDb()
    const outbox = createImLifecycleOutbox(db)
    const event = { eventId: 'retry-event', sessionId: SESSION_ID, stage: 'failed' as const, text: '任务失败，请重试。' }
    await expect(outbox.deliver(event, vi.fn().mockRejectedValueOnce(new Error('temporary')), authorize(event.text, event.sessionId))).rejects.toThrow('temporary')
    const retryReply = vi.fn().mockResolvedValue(undefined)
    await expect(outbox.deliver(event, retryReply)).rejects.toThrow('IM_OUTBOUND_FINAL_CHECK_REQUIRED')
    expect(retryReply).not.toHaveBeenCalled()
    expect(outbox.listPending(SESSION_ID)).toMatchObject([{ eventId: event.eventId, state: 'pending' }])
    db.close()
  })

  it('does not replay a pending lifecycle message when authorization facts bind different text', async () => {
    const db = createMemoryAppDb()
    const outbox = createImLifecycleOutbox(db)
    const event = { eventId: 'changed-retry-event', sessionId: SESSION_ID, stage: 'failed' as const, text: '任务失败，请检查桌面会话。' }
    await expect(outbox.deliver(event, vi.fn().mockRejectedValueOnce(new Error('temporary')), authorize(event.text, event.sessionId)))
      .rejects.toThrow('temporary')

    const retryReply = vi.fn().mockResolvedValue(undefined)
    await expect(outbox.deliver(event, retryReply, authorize('不同正文', event.sessionId)))
      .rejects.toThrow('IM_OUTBOUND_FINAL_CHECK_REQUIRED')

    expect(retryReply).not.toHaveBeenCalled()
    expect(outbox.listPending(SESSION_ID)).toMatchObject([{ eventId: event.eventId, state: 'pending', text: event.text }])
    db.close()
  })

  it('keeps lifecycle system-error bodies out of the dedicated deferred-approval notification channel', async () => {
    const reply = vi.fn().mockResolvedValue(undefined)
    const errorText = '批准 07 / 拒绝 07：系统发送失败'
    await expect(sendImLifecycleMessage({ reply, stage: 'failed', text: errorText }))
      .rejects.toThrow('IM_OUTBOUND_FINAL_CHECK_REQUIRED')
    expect(reply).not.toHaveBeenCalled()
  })
})
