import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerArtifactDecisionRequest,
  resetArtifactDecisionBridgeForTests,
  submitArtifactDecisionResponse,
  waitForArtifactDecisionResponse
} from '../artifacts/artifactDecisionBridge'
import { handleArtifactDecisionInbound } from './artifactDecisionImBridge'

describe('desktop vs IM race on shared submit', () => {
  afterEach(() => {
    resetArtifactDecisionBridgeForTests()
    vi.useRealTimers()
  })

  const options = [
    { key: 'overwrite', label: '覆盖' },
    { key: 'cancel', label: '取消' }
  ]

  it('desktop resolved first then IM gets stale', async () => {
    vi.useFakeTimers()
    const request = registerArtifactDecisionRequest(
      {
        requestId: 'req-race-1',
        sessionId: 'sess-1',
        toolUseId: 'tool-1',
        attempt: 1,
        kind: 'overwrite',
        options
      },
      {
        source: 'feishu',
        authOwner: 'ou_a',
        privateChatTarget: 'chat-1',
        originSessionId: 'sess-1',
        requestId: 'req-race-1'
      }
    )
    const waitPromise = waitForArtifactDecisionResponse(request.requestId, request.toolUseId)

    expect(
      submitArtifactDecisionResponse({
        decisionId: request.decisionId,
        requestId: request.requestId,
        sessionId: request.sessionId,
        toolUseId: request.toolUseId,
        attempt: request.attempt,
        choice: 'overwrite'
      })
    ).toBe('resolved')
    await vi.runAllTimersAsync()
    await expect(waitPromise).resolves.toMatchObject({ choice: 'overwrite' })

    const replyText = vi.fn()
    const result = await handleArtifactDecisionInbound({
      raw: `${request.decisionId} 2`,
      identity: { source: 'feishu', authOwner: 'ou_a', privateChatTarget: 'chat-1' },
      authorizeBeforeSubmit: () => ({ ok: true }),
      replyText,
      audit: vi.fn()
    })
    expect(result).toEqual({ handled: true, reason: 'stale' })
    expect(replyText.mock.calls.some((c) => String(c[0]).includes('已处理或已失效'))).toBe(true)
  })

  it('IM resolved first then desktop submit gets stale', async () => {
    vi.useFakeTimers()
    const request = registerArtifactDecisionRequest(
      {
        requestId: 'req-race-2',
        sessionId: 'sess-2',
        toolUseId: 'tool-2',
        attempt: 1,
        kind: 'overwrite',
        options
      },
      {
        source: 'feishu',
        authOwner: 'ou_a',
        privateChatTarget: 'chat-1',
        originSessionId: 'sess-2',
        requestId: 'req-race-2'
      }
    )
    const waitPromise = waitForArtifactDecisionResponse(request.requestId, request.toolUseId)

    const im = await handleArtifactDecisionInbound({
      raw: '1',
      identity: { source: 'feishu', authOwner: 'ou_a', privateChatTarget: 'chat-1' },
      authorizeBeforeSubmit: () => ({ ok: true }),
      replyText: vi.fn(),
      audit: vi.fn()
    })
    expect(im).toEqual({ handled: true, reason: 'resolved' })
    await vi.runAllTimersAsync()
    await expect(waitPromise).resolves.toMatchObject({ choice: 'overwrite' })

    expect(
      submitArtifactDecisionResponse({
        decisionId: request.decisionId,
        requestId: request.requestId,
        sessionId: request.sessionId,
        toolUseId: request.toolUseId,
        attempt: request.attempt,
        choice: 'cancel'
      })
    ).toBe('stale')
  })
})
