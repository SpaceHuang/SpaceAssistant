import { describe, expect, it, vi } from 'vitest'
import { resolveHostedBrowserGateFacts } from './hostedBrowserGateFacts'

describe('resolveHostedBrowserGateFacts', () => {
  const config = { actRequiresConfirm: true } as never
  const assess = vi.fn(async (_sessionId: string, _input: Record<string, unknown>, _config: unknown, _failClosed: boolean) => ({
    dangerous: true as const, source: 'keyword' as const, userReason: 'submit', consequence: 'money' as const, detail: 'submit'
  }))

  it('refreshes current URL and danger assessment on each initial/recheck evaluation', async () => {
    const peekCurrentUrl = vi.fn(() => 'https://example.test/account')
    const onAssessing = vi.fn()
    const facts = await resolveHostedBrowserGateFacts({
      sessionId: 'session', toolName: 'browser', toolInput: { action: 'act', instruction: 'submit' },
      browserConfig: config, remote: false, peekCurrentUrl, assess, onAssessing
    })
    expect(facts).toMatchObject({ currentPageUrl: 'https://example.test/account', dangerAssessment: { dangerous: true } })
    expect(assess).toHaveBeenCalledWith('session', { action: 'act', instruction: 'submit' }, config, false)
    expect(onAssessing).toHaveBeenCalledOnce()
  })

  it('fails remote browser assessment closed while desktop preserves legacy uncertainty behavior', async () => {
    const broken = vi.fn(async () => { throw new Error('scan failed') })
    const remote = await resolveHostedBrowserGateFacts({ sessionId: 'session', toolName: 'browser', toolInput: { action: 'act' }, browserConfig: config, remote: true, peekCurrentUrl: () => undefined, assess: broken })
    expect(remote.dangerAssessment).toMatchObject({ dangerous: true, detail: 'assess_error' })
    const desktop = await resolveHostedBrowserGateFacts({ sessionId: 'session', toolName: 'browser', toolInput: { action: 'act' }, browserConfig: config, remote: false, peekCurrentUrl: () => undefined, assess: broken })
    expect(desktop.dangerAssessment).toBeNull()
  })

  it('always refreshes browser URL but skips act danger scan when policy does not require one', async () => {
    assess.mockClear()
    const facts = await resolveHostedBrowserGateFacts({
      sessionId: 'session', toolName: 'browser', toolInput: { action: 'act', instruction: 'click' },
      browserConfig: { actRequiresConfirm: false } as never, remote: false,
      peekCurrentUrl: () => 'https://example.test', assess
    })
    expect(facts).toEqual({ currentPageUrl: 'https://example.test' })
    expect(assess).not.toHaveBeenCalled()
  })
})
