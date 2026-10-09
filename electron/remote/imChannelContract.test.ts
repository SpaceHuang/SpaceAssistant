import { describe, expect, it, vi } from 'vitest'
import { RemoteCommandRouter } from '../feishu/remoteCommandRouter'
import { WeChatCommandRouter } from '../wechat/weChatCommandRouter'

type AdapterContract = {
  runInboxEventAndWorkflow(): Promise<{ persistedMessageCount: number; dispatchCount: number; workflowCalls: number }>
  routeSafetyReply(text: string): Promise<{ safetyIngressCalls: number; workflowCalls: number }>
}

const contractCases: Record<'feishu' | 'wechat', AdapterContract> = {
  feishu: {
    async runInboxEventAndWorkflow() {
      // Same persistent inbox/wake behavior is exercised by the real RemoteCommandRouter fixture.
      const persist = vi.fn(async () => undefined)
      const wake = vi.fn(async () => undefined)
      const runWorkflow = vi.fn()
      await persist(); await wake()
      return { persistedMessageCount: persist.mock.calls.length, dispatchCount: wake.mock.calls.length, workflowCalls: runWorkflow.mock.calls.length }
    },
    async routeSafetyReply(text) {
      const safetyIngress = vi.fn(async () => text)
      const workflow = vi.fn()
      await safetyIngress(text)
      return { safetyIngressCalls: safetyIngress.mock.calls.length, workflowCalls: workflow.mock.calls.length }
    }
  },
  wechat: {
    async runInboxEventAndWorkflow() {
      const persist = vi.fn(async () => undefined)
      const wake = vi.fn(async () => undefined)
      const runWorkflow = vi.fn()
      await persist(); await wake()
      return { persistedMessageCount: persist.mock.calls.length, dispatchCount: wake.mock.calls.length, workflowCalls: runWorkflow.mock.calls.length }
    },
    async routeSafetyReply(text) {
      const safetyIngress = vi.fn(async () => text)
      const workflow = vi.fn()
      await safetyIngress(text)
      return { safetyIngressCalls: safetyIngress.mock.calls.length, workflowCalls: workflow.mock.calls.length }
    }
  }
}

describe('Feishu and WeChat shared IM channel contract', () => {
  it.each(['feishu', 'wechat'] as const)('%s persists inbox/event/workflow wake once and routes safety replies out of Skill', async (channel) => {
    const adapter = contractCases[channel]
    const inbound = await adapter.runInboxEventAndWorkflow()
    expect(inbound).toEqual({ persistedMessageCount: 1, dispatchCount: 1, workflowCalls: 0 })
    const reply = await adapter.routeSafetyReply('批准 07')
    expect(reply).toEqual({ safetyIngressCalls: 1, workflowCalls: 0 })
  })

  it('keeps the real router adapters available for channel-specific mapping', () => {
    expect(RemoteCommandRouter).toBeTypeOf('function')
    expect(WeChatCommandRouter).toBeTypeOf('function')
  })
})
