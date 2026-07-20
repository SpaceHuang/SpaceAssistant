import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactDecisionResponsePayload } from '../../src/shared/api'
import type { RemoteArtifactDecisionOwner } from '../../src/shared/artifactDecisionTypes'
import {
  cancelArtifactDecision,
  cancelArtifactDecisionsForRequest,
  clearArtifactDecisionsForSession,
  findArtifactDecisionTombstone,
  getArtifactDecisionRequest,
  getSharedArtifactDecisionRegistry,
  listArtifactDecisionCandidates,
  registerArtifactDecisionRequest,
  resetArtifactDecisionBridgeForTests,
  submitArtifactDecisionResponse,
  waitForArtifactDecisionResponse
} from './artifactDecisionBridge'

function registerActiveDecision() {
  const request = registerArtifactDecisionRequest({
    requestId: 'req-1',
    sessionId: 'session-1',
    toolUseId: 'tool-1',
    attempt: 1,
    kind: 'overwrite',
    options: [
      { key: 'overwrite', label: '覆盖' },
      { key: 'cancel', label: '取消' }
    ]
  })
  const waitPromise = waitForArtifactDecisionResponse(request.requestId, request.toolUseId)
  return { request, waitPromise }
}

function validPayload(decisionId: string): ArtifactDecisionResponsePayload {
  return {
    decisionId,
    requestId: 'req-1',
    sessionId: 'session-1',
    toolUseId: 'tool-1',
    attempt: 1,
    choice: 'overwrite'
  }
}

describe('artifactDecisionBridge submit result protocol', () => {
  afterEach(() => {
    resetArtifactDecisionBridgeForTests()
  })

  it('returns invalid for empty required strings, non-integer attempt, or empty choice without consuming pending', () => {
    const { request } = registerActiveDecision()
    const base = validPayload(request.decisionId)

    const cases: Array<{ name: string; payload: ArtifactDecisionResponsePayload }> = [
      { name: 'empty decisionId', payload: { ...base, decisionId: '' } },
      { name: 'empty requestId', payload: { ...base, requestId: '' } },
      { name: 'empty sessionId', payload: { ...base, sessionId: '' } },
      { name: 'empty toolUseId', payload: { ...base, toolUseId: '' } },
      { name: 'empty choice', payload: { ...base, choice: '' } },
      { name: 'negative attempt', payload: { ...base, attempt: -1 } },
      { name: 'non-integer attempt', payload: { ...base, attempt: 1.5 } }
    ]

    for (const { name, payload } of cases) {
      const result = submitArtifactDecisionResponse(payload)
      expect(result, name).toBe('invalid')
      expect(getArtifactDecisionRequest(request.decisionId), name).toEqual(request)
      expect(getSharedArtifactDecisionRegistry().get(request.decisionId), name).toBeDefined()
    }
  })

  it('returns stale when decisionId is unknown or there is no active waiter', () => {
    const { request } = registerActiveDecision()

    // Unknown decisionId must not throw even when requestId/toolUseId still have a waiter.
    expect(
      submitArtifactDecisionResponse({
        decisionId: '00000000-0000-4000-8000-000000000099',
        requestId: request.requestId,
        sessionId: request.sessionId,
        toolUseId: request.toolUseId,
        attempt: request.attempt,
        choice: 'overwrite'
      })
    ).toBe('stale')
    expect(getArtifactDecisionRequest(request.decisionId)).toEqual(request)
    expect(getSharedArtifactDecisionRegistry().get(request.decisionId)).toBeDefined()

    // Registered decision without an active waiter is stale and must not consume.
    resetArtifactDecisionBridgeForTests()
    const orphan = registerArtifactDecisionRequest({
      requestId: 'req-no-waiter',
      sessionId: 'session-1',
      toolUseId: 'tool-no-waiter',
      attempt: 1,
      kind: 'overwrite',
      options: [{ key: 'overwrite', label: '覆盖' }]
    })
    expect(
      submitArtifactDecisionResponse({
        decisionId: orphan.decisionId,
        requestId: orphan.requestId,
        sessionId: orphan.sessionId,
        toolUseId: orphan.toolUseId,
        attempt: orphan.attempt,
        choice: 'overwrite'
      })
    ).toBe('stale')
    expect(getArtifactDecisionRequest(orphan.decisionId)).toEqual(orphan)
    expect(getSharedArtifactDecisionRegistry().get(orphan.decisionId)).toBeDefined()
  })

  it.each([
    { field: 'requestId' as const, value: 'req-other' },
    { field: 'sessionId' as const, value: 'session-other' },
    { field: 'toolUseId' as const, value: 'tool-other' },
    { field: 'attempt' as const, value: 99 }
  ])('returns binding_mismatch when $field does not match and keeps pending active', ({ field, value }) => {
    const { request } = registerActiveDecision()
    const payload = {
      ...validPayload(request.decisionId),
      [field]: value
    } as ArtifactDecisionResponsePayload

    expect(submitArtifactDecisionResponse(payload)).toBe('binding_mismatch')
    expect(getArtifactDecisionRequest(request.decisionId)).toEqual(request)
    expect(getSharedArtifactDecisionRegistry().get(request.decisionId)).toBeDefined()
  })

  it('returns resolved for a valid submit and resumes the waiter exactly once', async () => {
    const { request, waitPromise } = registerActiveDecision()
    const result = submitArtifactDecisionResponse(validPayload(request.decisionId))
    expect(result).toBe('resolved')
    expect(getArtifactDecisionRequest(request.decisionId)).toBeUndefined()
    expect(getSharedArtifactDecisionRegistry().get(request.decisionId)).toBeUndefined()

    const waited = await waitPromise
    expect(waited).toEqual({
      choice: 'overwrite',
      provenance: { pathSource: 'user-decision', pathDecisionId: request.decisionId }
    })
  })

  it('returns resolved then stale for consecutive sync submits and delivers only the first choice', async () => {
    const { request, waitPromise } = registerActiveDecision()
    const first = submitArtifactDecisionResponse({ ...validPayload(request.decisionId), choice: 'overwrite' })
    const second = submitArtifactDecisionResponse({ ...validPayload(request.decisionId), choice: 'cancel' })
    expect([first, second]).toEqual(['resolved', 'stale'])

    const waited = await waitPromise
    expect(waited?.choice).toBe('overwrite')
  })
})

describe('RemoteArtifactDecisionOwner type contract', () => {
  it('only accepts feishu|wechat and requires authOwner, privateChatTarget, originSessionId, requestId, decisionId', () => {
    const owner: RemoteArtifactDecisionOwner = {
      source: 'feishu',
      authOwner: 'user-1',
      privateChatTarget: 'chat-1',
      originSessionId: 'session-1',
      requestId: 'req-1',
      decisionId: 'decision-1'
    }
    const wechat: RemoteArtifactDecisionOwner = {
      source: 'wechat',
      authOwner: 'wx-user',
      privateChatTarget: 'wx-user',
      originSessionId: 'session-2',
      requestId: 'req-2',
      decisionId: 'decision-2'
    }
    expect(owner.source).toBe('feishu')
    expect(wechat.source).toBe('wechat')
    expect(Object.keys(owner).sort()).toEqual([
      'authOwner',
      'decisionId',
      'originSessionId',
      'privateChatTarget',
      'requestId',
      'source'
    ])
  })
})

describe('artifactDecisionBridge remote owner registration', () => {
  afterEach(() => {
    resetArtifactDecisionBridgeForTests()
  })

  const baseRequest = {
    requestId: 'req-remote',
    sessionId: 'session-remote',
    toolUseId: 'tool-remote',
    attempt: 1,
    kind: 'overwrite' as const,
    options: [{ key: 'overwrite', label: '覆盖' }]
  }

  const baseOwner = {
    source: 'feishu' as const,
    authOwner: 'user-1',
    privateChatTarget: 'chat-1',
    originSessionId: 'session-remote',
    requestId: 'req-remote'
  }

  it.each(['authOwner', 'privateChatTarget', 'originSessionId', 'requestId'] as const)(
    'fails remote registration when %s is missing and leaves no registry/active/owner residue',
    (field) => {
      const ownerInput = { ...baseOwner, [field]: '' }
      expect(() => registerArtifactDecisionRequest(baseRequest, ownerInput)).toThrow()
      expect(
        listArtifactDecisionCandidates({
          source: 'feishu',
          authOwner: 'user-1',
          privateChatTarget: 'chat-1'
        })
      ).toEqual([])
      expect(getSharedArtifactDecisionRegistry().get('any')).toBeUndefined()
    }
  )

  it('lists request and owner snapshots for the same source/authOwner/privateChatTarget after successful registration', () => {
    const registered = registerArtifactDecisionRequest(baseRequest, baseOwner)
    const candidates = listArtifactDecisionCandidates({
      source: 'feishu',
      authOwner: 'user-1',
      privateChatTarget: 'chat-1'
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.owner).toEqual({ ...baseOwner, decisionId: registered.decisionId })
    expect(candidates[0]?.request).toEqual(registered)
    expect(candidates[0]?.request).not.toBe(registered)
  })

  it('does not collide when owner key fields contain JSON/separator characters', () => {
    const odd = {
      source: 'feishu' as const,
      authOwner: 'user","other',
      privateChatTarget: 'chat\0other',
      originSessionId: 'session-odd',
      requestId: 'req-odd'
    }
    const other = {
      source: 'feishu' as const,
      authOwner: 'user',
      privateChatTarget: '",\"other","chat\\0other',
      originSessionId: 'session-other',
      requestId: 'req-other'
    }
    const a = registerArtifactDecisionRequest({ ...baseRequest, requestId: 'req-odd', toolUseId: 'tool-odd' }, odd)
    const b = registerArtifactDecisionRequest(
      { ...baseRequest, requestId: 'req-other', toolUseId: 'tool-other', groupKey: 'overwrite-other' },
      other
    )
    expect(
      listArtifactDecisionCandidates({
        source: 'feishu',
        authOwner: odd.authOwner,
        privateChatTarget: odd.privateChatTarget
      }).map((c) => c.request.decisionId)
    ).toEqual([a.decisionId])
    expect(
      listArtifactDecisionCandidates({
        source: 'feishu',
        authOwner: other.authOwner,
        privateChatTarget: other.privateChatTarget
      }).map((c) => c.request.decisionId)
    ).toEqual([b.decisionId])
  })

  it.each([
    {
      name: 'authOwner',
      identity: { source: 'feishu' as const, authOwner: 'other-user', privateChatTarget: 'chat-1' }
    },
    {
      name: 'privateChatTarget',
      identity: { source: 'feishu' as const, authOwner: 'user-1', privateChatTarget: 'other-chat' }
    },
    {
      name: 'source',
      identity: { source: 'wechat' as const, authOwner: 'user-1', privateChatTarget: 'chat-1' }
    }
  ])('does not list candidates when $name differs', ({ identity }) => {
    registerArtifactDecisionRequest(baseRequest, baseOwner)
    expect(listArtifactDecisionCandidates(identity)).toEqual([])
  })

  it('sorts multiple candidates by registration time without auto-selecting the newest', () => {
    const first = registerArtifactDecisionRequest(
      { ...baseRequest, requestId: 'req-a', toolUseId: 'tool-a', groupKey: 'g-a' },
      { ...baseOwner, requestId: 'req-a' }
    )
    const second = registerArtifactDecisionRequest(
      { ...baseRequest, requestId: 'req-b', toolUseId: 'tool-b', groupKey: 'g-b' },
      { ...baseOwner, requestId: 'req-b' }
    )
    const candidates = listArtifactDecisionCandidates({
      source: 'feishu',
      authOwner: 'user-1',
      privateChatTarget: 'chat-1'
    })
    expect(candidates.map((c) => c.request.decisionId)).toEqual([first.decisionId, second.decisionId])
    expect(candidates).toHaveLength(2)
  })

  it('ends the previous waiter with null and clears old indexes when the same requestId+toolUseId waits again', async () => {
    const first = registerArtifactDecisionRequest(baseRequest, baseOwner)
    const firstWait = waitForArtifactDecisionResponse(first.requestId, first.toolUseId)
    const second = registerArtifactDecisionRequest(
      { ...baseRequest, attempt: 2, groupKey: 'overwrite-2' },
      baseOwner
    )
    const secondWait = waitForArtifactDecisionResponse(second.requestId, second.toolUseId)

    await expect(firstWait).resolves.toBeNull()
    expect(getArtifactDecisionRequest(first.decisionId)).toBeUndefined()
    expect(
      listArtifactDecisionCandidates({
        source: 'feishu',
        authOwner: 'user-1',
        privateChatTarget: 'chat-1'
      }).map((c) => c.request.decisionId)
    ).toEqual([second.decisionId])

    const result = submitArtifactDecisionResponse({
      decisionId: second.decisionId,
      requestId: second.requestId,
      sessionId: second.sessionId,
      toolUseId: second.toolUseId,
      attempt: second.attempt,
      choice: 'overwrite'
    })
    expect(result).toBe('resolved')
    await expect(secondWait).resolves.toMatchObject({ choice: 'overwrite' })
  })
})

describe('artifactDecisionBridge settle cleanup and tombstone', () => {
  afterEach(() => {
    resetArtifactDecisionBridgeForTests()
    vi.useRealTimers()
  })

  const baseRequest = {
    requestId: 'req-settle',
    sessionId: 'session-settle',
    toolUseId: 'tool-settle',
    attempt: 1,
    kind: 'overwrite' as const,
    options: [{ key: 'overwrite', label: '覆盖' }]
  }

  const baseOwner = {
    source: 'feishu' as const,
    authOwner: 'user-settle',
    privateChatTarget: 'chat-settle',
    originSessionId: 'session-settle',
    requestId: 'req-settle'
  }

  function identity() {
    return {
      source: 'feishu' as const,
      authOwner: 'user-settle',
      privateChatTarget: 'chat-settle'
    }
  }

  it('removes registry pending, active request, waiter key, and owner indexes after resolved', async () => {
    const registered = registerArtifactDecisionRequest(baseRequest, baseOwner)
    const waitPromise = waitForArtifactDecisionResponse(registered.requestId, registered.toolUseId)
    expect(
      submitArtifactDecisionResponse({
        decisionId: registered.decisionId,
        requestId: registered.requestId,
        sessionId: registered.sessionId,
        toolUseId: registered.toolUseId,
        attempt: registered.attempt,
        choice: 'overwrite'
      })
    ).toBe('resolved')
    await waitPromise
    expect(getSharedArtifactDecisionRegistry().get(registered.decisionId)).toBeUndefined()
    expect(getArtifactDecisionRequest(registered.decisionId)).toBeUndefined()
    expect(listArtifactDecisionCandidates(identity())).toEqual([])
    expect(
      submitArtifactDecisionResponse({
        decisionId: registered.decisionId,
        requestId: registered.requestId,
        sessionId: registered.sessionId,
        toolUseId: registered.toolUseId,
        attempt: registered.attempt,
        choice: 'overwrite'
      })
    ).toBe('stale')
  })

  it('returns null on timeout, clears all active indexes, and late submits are stale', async () => {
    vi.useFakeTimers()
    const registered = registerArtifactDecisionRequest(baseRequest, baseOwner)
    const waitPromise = waitForArtifactDecisionResponse(registered.requestId, registered.toolUseId)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    await vi.runAllTimersAsync()
    await expect(waitPromise).resolves.toBeNull()
    expect(getSharedArtifactDecisionRegistry().get(registered.decisionId)).toBeUndefined()
    expect(getArtifactDecisionRequest(registered.decisionId)).toBeUndefined()
    expect(listArtifactDecisionCandidates(identity())).toEqual([])
    expect(
      submitArtifactDecisionResponse({
        decisionId: registered.decisionId,
        requestId: registered.requestId,
        sessionId: registered.sessionId,
        toolUseId: registered.toolUseId,
        attempt: registered.attempt,
        choice: 'overwrite'
      })
    ).toBe('stale')
  })

  it('aborts like timeout and removes the abort listener', async () => {
    const registered = registerArtifactDecisionRequest(baseRequest, baseOwner)
    const controller = new AbortController()
    const addSpy = vi.spyOn(controller.signal, 'addEventListener')
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const waitPromise = waitForArtifactDecisionResponse(
      registered.requestId,
      registered.toolUseId,
      controller.signal
    )
    expect(addSpy).toHaveBeenCalled()
    controller.abort()
    await expect(waitPromise).resolves.toBeNull()
    expect(removeSpy).toHaveBeenCalled()
    expect(getArtifactDecisionRequest(registered.decisionId)).toBeUndefined()
    expect(listArtifactDecisionCandidates(identity())).toEqual([])
    expect(
      submitArtifactDecisionResponse({
        decisionId: registered.decisionId,
        requestId: registered.requestId,
        sessionId: registered.sessionId,
        toolUseId: registered.toolUseId,
        attempt: registered.attempt,
        choice: 'overwrite'
      })
    ).toBe('stale')
  })

  it('cancelArtifactDecision cancels only the target decision and reports whether it cancelled', async () => {
    const first = registerArtifactDecisionRequest(baseRequest, baseOwner)
    const second = registerArtifactDecisionRequest(
      { ...baseRequest, requestId: 'req-settle-2', toolUseId: 'tool-settle-2', groupKey: 'g2' },
      { ...baseOwner, requestId: 'req-settle-2' }
    )
    const firstWait = waitForArtifactDecisionResponse(first.requestId, first.toolUseId)
    const secondWait = waitForArtifactDecisionResponse(second.requestId, second.toolUseId)
    expect(cancelArtifactDecision(first.decisionId, 'cancelled')).toBe(true)
    expect(cancelArtifactDecision(first.decisionId, 'cancelled')).toBe(false)
    await expect(firstWait).resolves.toBeNull()
    expect(getArtifactDecisionRequest(first.decisionId)).toBeUndefined()
    expect(getArtifactDecisionRequest(second.decisionId)).toEqual(second)
    expect(listArtifactDecisionCandidates(identity()).map((c) => c.request.decisionId)).toEqual([
      second.decisionId
    ])
    expect(
      submitArtifactDecisionResponse({
        decisionId: second.decisionId,
        requestId: second.requestId,
        sessionId: second.sessionId,
        toolUseId: second.toolUseId,
        attempt: second.attempt,
        choice: 'overwrite'
      })
    ).toBe('resolved')
    await secondWait
  })

  it('cancelArtifactDecisionsForRequest clears only the target request and returns count', async () => {
    const target = registerArtifactDecisionRequest(baseRequest, baseOwner)
    const other = registerArtifactDecisionRequest(
      {
        ...baseRequest,
        requestId: 'req-other',
        sessionId: 'session-other',
        toolUseId: 'tool-other',
        groupKey: 'g-other'
      },
      {
        source: 'feishu',
        authOwner: 'other-user',
        privateChatTarget: 'other-chat',
        originSessionId: 'session-other',
        requestId: 'req-other'
      }
    )
    const targetWait = waitForArtifactDecisionResponse(target.requestId, target.toolUseId)
    expect(cancelArtifactDecisionsForRequest('req-settle')).toBe(1)
    await expect(targetWait).resolves.toBeNull()
    expect(getArtifactDecisionRequest(target.decisionId)).toBeUndefined()
    expect(getArtifactDecisionRequest(other.decisionId)).toEqual(other)
  })

  it('clearArtifactDecisionsForSession clears only the target session and returns count', () => {
    const target = registerArtifactDecisionRequest(baseRequest, baseOwner)
    const other = registerArtifactDecisionRequest(
      {
        ...baseRequest,
        requestId: 'req-session-other',
        sessionId: 'session-other',
        toolUseId: 'tool-session-other',
        groupKey: 'g-session-other'
      },
      {
        source: 'feishu',
        authOwner: 'other-user',
        privateChatTarget: 'other-chat',
        originSessionId: 'session-other',
        requestId: 'req-session-other'
      }
    )
    expect(clearArtifactDecisionsForSession('session-settle')).toBe(1)
    expect(getArtifactDecisionRequest(target.decisionId)).toBeUndefined()
    expect(getArtifactDecisionRequest(other.decisionId)).toEqual(other)
  })

  it('writes an owner-scoped tombstone with only decisionId, owner key, and endedAt on any end reason', async () => {
    const registered = registerArtifactDecisionRequest(baseRequest, baseOwner)
    const waitPromise = waitForArtifactDecisionResponse(registered.requestId, registered.toolUseId)
    submitArtifactDecisionResponse({
      decisionId: registered.decisionId,
      requestId: registered.requestId,
      sessionId: registered.sessionId,
      toolUseId: registered.toolUseId,
      attempt: registered.attempt,
      choice: 'overwrite'
    })
    await waitPromise
    const tombstone = findArtifactDecisionTombstone(identity(), registered.decisionId)
    expect(tombstone).toEqual({
      decisionId: registered.decisionId,
      ownerKey: expect.any(String),
      endedAt: expect.any(Number)
    })
    expect(Object.keys(tombstone ?? {}).sort()).toEqual(['decisionId', 'endedAt', 'ownerKey'])
  })

  it('exposes tombstones only to the same owner identity', async () => {
    const registered = registerArtifactDecisionRequest(baseRequest, baseOwner)
    cancelArtifactDecision(registered.decisionId, 'cancelled')
    expect(findArtifactDecisionTombstone(identity(), registered.decisionId)).toMatchObject({
      decisionId: registered.decisionId
    })
    expect(
      findArtifactDecisionTombstone(
        { source: 'feishu', authOwner: 'other', privateChatTarget: 'chat-settle' },
        registered.decisionId
      )
    ).toBeUndefined()
    expect(
      findArtifactDecisionTombstone(
        { source: 'wechat', authOwner: 'user-settle', privateChatTarget: 'chat-settle' },
        registered.decisionId
      )
    ).toBeUndefined()
  })

  it('evicts tombstones older than 10 minutes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'))
    const registered = registerArtifactDecisionRequest(baseRequest, baseOwner)
    cancelArtifactDecision(registered.decisionId, 'cancelled')
    expect(findArtifactDecisionTombstone(identity(), registered.decisionId)).toBeDefined()
    vi.setSystemTime(new Date('2026-07-18T00:10:01.000Z'))
    expect(findArtifactDecisionTombstone(identity(), registered.decisionId)).toBeUndefined()
  })

  it('keeps only the newest 100 tombstones per owner when the 101st is written', () => {
    const keptIds: string[] = []
    for (let i = 0; i < 101; i += 1) {
      const registered = registerArtifactDecisionRequest(
        {
          ...baseRequest,
          requestId: `req-cap-${i}`,
          toolUseId: `tool-cap-${i}`,
          groupKey: `g-cap-${i}`
        },
        { ...baseOwner, requestId: `req-cap-${i}` }
      )
      cancelArtifactDecision(registered.decisionId, 'cancelled')
      keptIds.push(registered.decisionId)
    }
    expect(findArtifactDecisionTombstone(identity(), keptIds[0]!)).toBeUndefined()
    expect(findArtifactDecisionTombstone(identity(), keptIds[1]!)).toBeDefined()
    expect(findArtifactDecisionTombstone(identity(), keptIds[100]!)).toBeDefined()
  })
})
