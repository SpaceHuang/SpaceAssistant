import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSimpleOutboundText,
  maybeTouchOutboundActivity,
  sendImOutbound
} from './imRemoteOutbound'
import { touchRemoteSessionActivity } from './remoteSessionActivity'

vi.mock('./remoteSessionActivity', () => ({
  touchRemoteSessionActivity: vi.fn()
}))

const SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const SUFFIX = '…（完整结果请查看桌面会话）'

describe('buildSimpleOutboundText / sendImOutbound', () => {
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
    expect(text.endsWith(` 会话$${SESSION_ID}$`)).toBe(true)
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
      touch: { db: {} as never, sessionId: SESSION_ID }
    })
    expect(reply).toHaveBeenCalledWith(expect.stringContaining(` 会话$${SESSION_ID}$`))
    expect(touchRemoteSessionActivity).toHaveBeenCalledOnce()
  })

  it('maybeTouchOutboundActivity no-ops without sessionId or touch', () => {
    maybeTouchOutboundActivity(undefined, { db: {} as never, sessionId: SESSION_ID })
    maybeTouchOutboundActivity(SESSION_ID, undefined)
    expect(touchRemoteSessionActivity).not.toHaveBeenCalled()
  })
})
