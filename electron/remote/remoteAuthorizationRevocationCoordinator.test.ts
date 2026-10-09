import { describe, expect, it, vi } from 'vitest'
import { createRemoteAuthorizationRevocationCoordinator } from './remoteAuthorizationRevocationCoordinator'

describe('remote authorization revocation coordinator', () => {
  it('does not report success or bump epoch when config persistence fails', async () => {
    const writeConfig = vi.fn(() => { throw new Error('config write failed') })
    const advanceEpoch = vi.fn()
    const cascade = vi.fn()
    const completeRevocation = vi.fn()
    const blockChannels = vi.fn()
    const markChannelsReady = vi.fn()
    const coordinator = createRemoteAuthorizationRevocationCoordinator({ writeConfig, advanceEpoch, cascade, completeRevocation, blockChannels, markChannelsReady })
    expect(() => coordinator.commit({ channels: ['feishu'], reason: 'remote_disabled' })).toThrow('config write failed')
    expect(advanceEpoch).not.toHaveBeenCalled()
    expect(blockChannels).toHaveBeenCalledWith(['feishu'], 'remote_disabled')
    expect(markChannelsReady).not.toHaveBeenCalled()
  })

  it('does not report success when epoch persistence fails', async () => {
    const writeConfig = vi.fn(() => ({ persisted: true }))
    const advanceEpoch = vi.fn(() => { throw new Error('epoch commit failed') })
    const cascade = vi.fn()
    const completeRevocation = vi.fn()
    const blockChannels = vi.fn()
    const markChannelsReady = vi.fn()
    const coordinator = createRemoteAuthorizationRevocationCoordinator({ writeConfig, advanceEpoch, cascade, completeRevocation, blockChannels, markChannelsReady })
    expect(() => coordinator.commit({ channels: ['feishu', 'wechat'], reason: 'owner_cleared' })).toThrow('epoch commit failed')
    expect(writeConfig).toHaveBeenCalledOnce()
    expect(advanceEpoch).toHaveBeenCalledWith('feishu', 'owner_cleared')
    expect(cascade).not.toHaveBeenCalled()
    expect(blockChannels).toHaveBeenCalledOnce()
    expect(markChannelsReady).not.toHaveBeenCalled()
  })

  it.each(['cascade failed', 'completion failed'] as const)('does not report success when %s', async (message) => {
    const writeConfig = vi.fn(() => ({ persisted: true }))
    const advanceEpoch = vi.fn(() => 2)
    const cascade = vi.fn(() => { if (message === 'cascade failed') throw new Error(message) })
    const completeRevocation = vi.fn(() => { if (message === 'completion failed') throw new Error(message); return true })
    const blockChannels = vi.fn()
    const markChannelsReady = vi.fn()
    const coordinator = createRemoteAuthorizationRevocationCoordinator({ writeConfig, advanceEpoch, cascade, completeRevocation, blockChannels, markChannelsReady })
    expect(() => coordinator.commit({ channels: ['feishu', 'wechat'], reason: 'owner_cleared' })).toThrow(message)
    expect(advanceEpoch).toHaveBeenCalledWith('feishu', 'owner_cleared')
    if (message === 'cascade failed') expect(completeRevocation).not.toHaveBeenCalled()
    expect(markChannelsReady).not.toHaveBeenCalled()
  })

  it('returns success only after config, epoch, and every channel cascade complete', async () => {
    const order: string[] = []
    const coordinator = createRemoteAuthorizationRevocationCoordinator({
      writeConfig: () => { order.push('config'); return { persisted: true } },
      advanceEpoch: (channel) => { order.push(`epoch:${channel}`); return channel === 'feishu' ? 2 : 3 },
      cascade: (channel) => { order.push(`cascade:${channel}`) },
      completeRevocation: (channel) => { order.push(`complete:${channel}`); return true },
      blockChannels: (channels) => { order.push(`block:${channels.join(',')}`) },
      markChannelsReady: (channels) => { order.push(`ready:${channels.join(',')}`) }
    })
    expect(coordinator.commit({ channels: ['feishu', 'wechat'], reason: 'allowlist_changed' })).toEqual({
      success: true, config: { persisted: true }, channels: ['feishu', 'wechat']
    })
    expect(order).toEqual(['block:feishu,wechat', 'config', 'epoch:feishu', 'cascade:feishu', 'complete:feishu',
      'epoch:wechat', 'cascade:wechat', 'complete:wechat', 'ready:feishu,wechat'])
  })
})
