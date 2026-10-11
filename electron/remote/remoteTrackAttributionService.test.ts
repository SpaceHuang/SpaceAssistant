import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createRemoteTrack, mapRemoteTrackMessage } from '../database/remoteTrackStore'
import { getDbConnection } from '../database'
import { createSession, deleteSession } from '../database/operations'
import { attributeAndPersistRemoteMessage, listRemoteTrackAttributionCandidates, observeRemoteMessageAttribution, readRemoteTrackContextForInbound } from './remoteTrackAttributionService'
import type { IntentAttributor } from './trackAttribution'

describe('remote Track attribution persistence boundary', () => {
  it('rejects attribution candidates and stale references after the origin session is deleted', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'deleted-track-origin' })
      createRemoteTrack(db, { trackId: 'deleted-origin-track', eventId: 'deleted-origin-root', idempotencyKey: 'deleted-origin-inbound',
        channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'deleted-origin-prompt',
        originSessionId: session.id, occurredAt: 1 })
      mapRemoteTrackMessage(db, { channel: 'wechat', platformMessageId: 'deleted-origin-prompt', trackId: 'deleted-origin-track',
        eventId: 'deleted-origin-root', direction: 'outbound' })
      deleteSession(db, session.id, { flush: false })

      expect(listRemoteTrackAttributionCandidates(db, { channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1 })).toEqual([])
      const classifier: IntentAttributor = { classify: vi.fn() }
      expect(await attributeAndPersistRemoteMessage(db, { channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        platformMessageId: 'reply-after-delete', replyToPlatformMessageId: 'deleted-origin-prompt', text: '继续', now: 2 }, classifier))
        .toEqual({ kind: 'unresolved', decision: { kind: 'rejected', reasonCode: 'explicit-reference-unavailable' } })
      expect(classifier.classify).not.toHaveBeenCalled()
    } finally { db.close() }
  })

  it('records shadow attribution without creating Tracks, mappings, or changing the legacy route decision', async () => {
    const db = createMemoryAppDb()
    try {
      const classifier: IntentAttributor = { classify: vi.fn(async () => ({ kind: 'scores', scores: [] })) }
      const result = await observeRemoteMessageAttribution(db, { channel: 'wechat', identityKey: 'user', ownerId: 'owner',
        authorizationEpoch: 1, platformMessageId: 'shadow-1', text: '不要持久化这段正文', now: 10 }, classifier)
      expect(result).toMatchObject({ decision: { kind: 'new-track' }, created: true })
      const conn = getDbConnection(db)
      expect(conn.prepare('SELECT COUNT(*) AS count FROM remote_tracks').get()).toEqual({ count: 0 })
      expect(conn.prepare('SELECT COUNT(*) AS count FROM remote_track_message_map').get()).toEqual({ count: 0 })
      const observation = conn.prepare('SELECT decision_kind,reason_code,candidate_snapshot_json FROM remote_track_attribution_observations').get() as {
        decision_kind: string; reason_code: string; candidate_snapshot_json: string
      }
      expect(observation).toMatchObject({ decision_kind: 'new-track', reason_code: 'no-eligible-candidates' })
      expect(JSON.stringify(observation)).not.toContain('不要持久化这段正文')
      expect(await observeRemoteMessageAttribution(db, { channel: 'wechat', identityKey: 'user', ownerId: 'owner',
        authorizationEpoch: 1, platformMessageId: 'shadow-1', text: '不要持久化这段正文', now: 11 }, classifier))
        .toMatchObject({ created: false })
    } finally { db.close() }
  })

  it('creates and maps a new Track when there are no eligible candidates', async () => {
    const db = createMemoryAppDb()
    try {
      const classifier: IntentAttributor = { classify: vi.fn() }
      const result = await attributeAndPersistRemoteMessage(db, {
        channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        platformMessageId: 'inbound-1', text: '查找本地模型', now: 10
      }, classifier)
      expect(result.kind).toBe('attributed')
      if (result.kind !== 'attributed') return
      expect(result.decision.kind).toBe('new-track')
      expect(result.context.rootMessageId).toBe('inbound-1')
      const event = getDbConnection(db).prepare('SELECT payload_json FROM remote_track_events WHERE event_id=?').get(result.context.attributionEventId) as { payload_json: string }
      expect(JSON.parse(event.payload_json)).toMatchObject({ attributionPolicyVersion: 'remote-intent-v1',
        classifierVersion: 'injected-classifier-v1', decisionSource: 'deterministic-new',
        continuationThreshold: 0.85, continuationMargin: 0.15 })
      expect(getDbConnection(db).prepare('SELECT track_id,event_id,direction FROM remote_track_message_map WHERE channel=? AND platform_message_id=?')
        .get('wechat', 'inbound-1')).toEqual({ track_id: result.context.trackId, event_id: result.context.attributionEventId, direction: 'inbound' })
      expect(classifier.classify).not.toHaveBeenCalled()
    } finally { db.close() }
  })

  it('persists actual classifier invocation and metering facts with a semantic continuation', async () => {
    const db = createMemoryAppDb()
    try {
      const sessionId = createSession(db, { name: 'metered-attribution-origin' }).id
      createRemoteTrack(db, { trackId: 'metered-candidate', eventId: 'metered-root', idempotencyKey: 'metered-inbound',
        channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        rootMessageId: 'metered-platform-root', originSessionId: sessionId, occurredAt: 1 })
      const classifier: IntentAttributor = {
        classifierVersion: 'model-v1',
        classify: vi.fn(async () => ({ kind: 'scores', scores: [{ trackId: 'metered-candidate', score: 0.99 }],
          metering: { providerCallMade: true, inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5,
            cacheCreationInputTokens: 0, estimatedCostUsd: null } }))
      }
      const result = await attributeAndPersistRemoteMessage(db, { channel: 'wechat', identityKey: 'user', ownerId: 'owner',
        authorizationEpoch: 1, platformMessageId: 'metered-follow-up', text: '继续刚才的问题', now: 5 }, classifier,
      { shadowObservationEnabled: true })
      expect(result).toMatchObject({ kind: 'attributed', decision: { kind: 'continuation', trackId: 'metered-candidate' } })
      if (result.kind !== 'attributed') return
      const event = getDbConnection(db).prepare('SELECT payload_json FROM remote_track_events WHERE event_id=?')
        .get(result.context.attributionEventId) as { payload_json: string }
      expect(JSON.parse(event.payload_json)).toMatchObject({ classifierVersion: 'model-v1', classifierInvoked: true,
        providerCallMade: true, classifierInputTokens: 100, classifierOutputTokens: 20, classifierCacheReadInputTokens: 5,
        classifierCacheCreationInputTokens: 0, classifierEstimatedCostUsd: null })
      expect(getDbConnection(db).prepare(`SELECT decision_kind,classifier_invoked,provider_call_made,input_tokens,estimated_cost_usd
        FROM remote_track_attribution_observations WHERE platform_message_id=?`).get('metered-follow-up'))
        .toEqual({ decision_kind: 'continuation', classifier_invoked: 1, provider_call_made: 1, input_tokens: 100, estimated_cost_usd: null })
    } finally { db.close() }
  })

  it('records a shadow continuation while keeping the formal route ambiguous when semantic continuation is off', async () => {
    const db = createMemoryAppDb()
    try {
      const sessionId = createSession(db, { name: 'shadow-with-semantic-off' }).id
      createRemoteTrack(db, { trackId: 'shadow-candidate', eventId: 'shadow-root', idempotencyKey: 'shadow-root-inbound',
        channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        rootMessageId: 'shadow-root-platform', originSessionId: sessionId, occurredAt: 1 })
      const classifier: IntentAttributor = { classifierVersion: 'shadow-model-v1', classify: vi.fn(async () => ({
        kind: 'scores', scores: [{ trackId: 'shadow-candidate', score: 0.96 }],
        metering: { providerCallMade: true, inputTokens: 50, outputTokens: 8, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCostUsd: 0.001 }
      })) }

      const result = await attributeAndPersistRemoteMessage(db, { channel: 'wechat', identityKey: 'user', ownerId: 'owner',
        authorizationEpoch: 1, platformMessageId: 'shadow-follow-up', text: '继续查这个问题', now: 5 }, classifier,
      { semanticEnabled: false, shadowObservationEnabled: true })

      expect(result).toMatchObject({ kind: 'unresolved', decision: { kind: 'ambiguous', reasonCode: 'semantic-continuation-disabled' } })
      expect(classifier.classify).toHaveBeenCalledOnce()
      expect(getDbConnection(db).prepare(`SELECT decision_kind,classifier_invoked,provider_call_made,input_tokens,estimated_cost_usd
        FROM remote_track_attribution_observations WHERE platform_message_id=?`).get('shadow-follow-up'))
        .toEqual({ decision_kind: 'continuation', classifier_invoked: 1, provider_call_made: 1, input_tokens: 50, estimated_cost_usd: 0.001 })
      expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM remote_track_message_map WHERE platform_message_id=?').get('shadow-follow-up'))
        .toEqual({ count: 0 })
    } finally { db.close() }
  })

  it('creates a separate Track for a shadow-classified new intent while semantic continuation remains off', async () => {
    const db = createMemoryAppDb()
    try {
      const sessionId = createSession(db, { name: 'shadow-new-intent-semantic-off' }).id
      createRemoteTrack(db, { trackId: 'old-task', eventId: 'old-task-root', idempotencyKey: 'old-task-inbound',
        channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        rootMessageId: 'old-task-platform-root', originSessionId: sessionId, occurredAt: 1 })
      const classifier: IntentAttributor = { classifierVersion: 'shadow-model-v1', classify: vi.fn(async () => ({
        kind: 'scores', scores: [{ trackId: 'old-task', score: 0.12 }],
        metering: { providerCallMade: true, inputTokens: 40, outputTokens: 6, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCostUsd: 0.001 }
      })) }

      const result = await attributeAndPersistRemoteMessage(db, { channel: 'wechat', identityKey: 'user', ownerId: 'owner',
        authorizationEpoch: 1, platformMessageId: 'new-task-platform-message', text: '帮我安排另一项独立任务', now: 5,
        resolveNewTrackSession: async () => sessionId }, classifier,
      { semanticEnabled: false, shadowObservationEnabled: true })

      expect(result).toMatchObject({ kind: 'attributed', decision: { kind: 'new-track', reasonCode: 'no-reasonable-continuation-candidate' } })
      expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM remote_track_message_map WHERE platform_message_id=?')
        .get('new-task-platform-message')).toEqual({ count: 1 })
      expect(getDbConnection(db).prepare(`SELECT decision_kind,reason_code,classifier_invoked FROM remote_track_attribution_observations
        WHERE platform_message_id=?`).get('new-task-platform-message'))
        .toEqual({ decision_kind: 'new-track', reason_code: 'no-reasonable-continuation-candidate', classifier_invoked: 1 })
    } finally { db.close() }
  })

  it('rolls back Track attribution and message mapping when durable inbound enqueue fails', async () => {
    const db = createMemoryAppDb()
    try {
      const sessionId = createSession(db, { name: 'atomic-attribution-origin' }).id
      await expect(attributeAndPersistRemoteMessage(db, { channel: 'wechat', identityKey: 'user', ownerId: 'owner',
        authorizationEpoch: 1, platformMessageId: 'atomic-inbound', text: '执行任务', now: 10, originSessionId: sessionId },
      { classify: vi.fn() }, { onPersisted: () => { throw new Error('inbox-write-failed') } })).rejects.toThrow('inbox-write-failed')
      const conn = getDbConnection(db)
      expect(conn.prepare('SELECT COUNT(*) AS count FROM remote_tracks').get()).toEqual({ count: 0 })
      expect(conn.prepare('SELECT COUNT(*) AS count FROM remote_track_events').get()).toEqual({ count: 0 })
      expect(conn.prepare('SELECT COUNT(*) AS count FROM remote_track_message_map').get()).toEqual({ count: 0 })
    } finally { db.close() }
  })

  it('reuses the persisted attribution receipt and event on an idempotent inbound retry', async () => {
    const db = createMemoryAppDb()
    try {
      const classifier: IntentAttributor = { classify: vi.fn() }
      const scope = { channel: 'wechat' as const, identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        platformMessageId: 'same-inbound', text: '同一条消息', now: 10 }
      const first = await attributeAndPersistRemoteMessage(db, scope, classifier)
      const retry = await attributeAndPersistRemoteMessage(db, scope, classifier)
      expect(retry).toEqual(first)
      expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM remote_tracks').get()).toEqual({ count: 1 })
      expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM remote_track_message_map WHERE platform_message_id=?').get('same-inbound'))
        .toEqual({ count: 1 })
    } finally { db.close() }
  })

  it('lets the first persisted receipt win when concurrent retries classify the same message differently', async () => {
    const db = createMemoryAppDb()
    try {
      const { createSession } = await import('../database/operations')
      const sessionId = createSession(db, { name: 'attribution-race-origin' }).id
      for (const trackId of ['candidate-a', 'candidate-b']) createRemoteTrack(db, { trackId, eventId: `${trackId}-root`,
        idempotencyKey: `${trackId}-inbound`, channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        rootMessageId: `${trackId}-platform-root`, originSessionId: sessionId, occurredAt: 1 })
      const completions: Array<(result: { kind: 'scores'; scores: Array<{ trackId: string; score: number }> }) => void> = []
      const classifier: IntentAttributor = { classify: vi.fn(() => new Promise((resolve) => { completions.push(resolve) })) }
      const scope = { channel: 'wechat' as const, identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        platformMessageId: 'race-inbound', text: '接着刚才的事情', now: 5 }
      const firstPromise = attributeAndPersistRemoteMessage(db, scope, classifier)
      const retryPromise = attributeAndPersistRemoteMessage(db, scope, classifier)
      await vi.waitFor(() => expect(completions).toHaveLength(2))
      completions[0]!({ kind: 'scores', scores: [{ trackId: 'candidate-a', score: 0.99 }, { trackId: 'candidate-b', score: 0.1 }] })
      const first = await firstPromise
      completions[1]!({ kind: 'scores', scores: [{ trackId: 'candidate-a', score: 0.1 }, { trackId: 'candidate-b', score: 0.99 }] })
      const retry = await retryPromise

      expect(first).toMatchObject({ kind: 'attributed', decision: { kind: 'continuation', trackId: 'candidate-a' } })
      expect(retry).toEqual(first)
      expect(getDbConnection(db).prepare('SELECT track_id FROM remote_track_message_map WHERE channel=? AND platform_message_id=?')
        .get('wechat', 'race-inbound')).toEqual({ track_id: 'candidate-a' })
    } finally { db.close() }
  })

  it('resolves a platform reference to its Track before semantic classification and maps the follow-up', async () => {
    const db = createMemoryAppDb()
    try {
      const { createSession } = await import('../database/operations')
      const originSessionId = createSession(db, { name: 'explicit-reference-origin' }).id
      createRemoteTrack(db, { trackId: 'track-a', eventId: 'root-a', idempotencyKey: 'root:a', channel: 'wechat',
        identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'prompt-a', originSessionId, occurredAt: 1 })
      mapRemoteTrackMessage(db, { channel: 'wechat', platformMessageId: 'prompt-a', trackId: 'track-a', eventId: 'root-a', direction: 'outbound' })
      const classifier: IntentAttributor = { classify: vi.fn() }
      const result = await attributeAndPersistRemoteMessage(db, { channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        platformMessageId: 'reply-a', replyToPlatformMessageId: 'prompt-a', text: '补充条件', now: 2 }, classifier)
      expect(result).toMatchObject({ kind: 'attributed', decision: { kind: 'continuation', trackId: 'track-a' },
        context: { trackId: 'track-a', rootMessageId: 'prompt-a', originSessionId } })
      expect(classifier.classify).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT track_id FROM remote_track_message_map WHERE channel=? AND platform_message_id=?').get('wechat', 'reply-a'))
        .toEqual({ track_id: 'track-a' })
    } finally { db.close() }
  })

  it('fails closed on an unresolved explicit platform reference', async () => {
    const db = createMemoryAppDb()
    try {
      const classifier: IntentAttributor = { classify: vi.fn(async () => ({ kind: 'scores', scores: [] })) }
      const result = await attributeAndPersistRemoteMessage(db, { channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        platformMessageId: 'reply-stale', replyToPlatformMessageId: 'missing-prompt', text: '允许 03', now: 2 }, classifier)
      expect(result).toEqual({ kind: 'unresolved', decision: { kind: 'rejected', reasonCode: 'explicit-reference-unavailable' } })
      expect(classifier.classify).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM remote_tracks').get()).toEqual({ count: 0 })
    } finally { db.close() }
  })

  it('lists only the current identity, owner, authorization epoch, and eligible Track states', async () => {
    const db = createMemoryAppDb()
    try {
      const { createSession } = await import('../database/operations')
      const sessionId = createSession(db, { name: 'candidate-list-origin' }).id
      createRemoteTrack(db, { trackId: 'track-a', eventId: 'root-a', idempotencyKey: 'root:a', channel: 'feishu',
        identityKey: 'user', ownerId: 'owner', authorizationEpoch: 2, rootMessageId: 'root-a', originSessionId: sessionId, occurredAt: 1 })
      createRemoteTrack(db, { trackId: 'track-other', eventId: 'root-other', idempotencyKey: 'root:other', channel: 'feishu',
        identityKey: 'other-user', ownerId: 'owner', authorizationEpoch: 2, rootMessageId: 'root-other', occurredAt: 2 })
      expect(listRemoteTrackAttributionCandidates(db, { channel: 'feishu', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 2 }))
        .toEqual([{ trackId: 'track-a', state: 'open', summary: '', updatedAt: 1 }])
    } finally { db.close() }
  })

  it('reconstructs wake Track context only when inbox attribution, owner, and epoch all match', async () => {
    const db = createMemoryAppDb()
    try {
      const { createSession } = await import('../database/operations')
      const { appendImInboxMessageWithWakeEvent } = await import('../database/imInbox')
      const { buildImQueueScope } = await import('../../src/shared/queueScope')
      const sessionId = createSession(db, { name: 'track-context-wake' }).id
      const attributed = await attributeAndPersistRemoteMessage(db, { channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        platformMessageId: 'queued-platform-id', text: 'queued task', now: 2, originSessionId: sessionId }, { classify: vi.fn() })
      expect(attributed.kind).toBe('attributed')
      if (attributed.kind !== 'attributed') return
      const queueScope = buildImQueueScope('wechat', sessionId)
      const queued = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope,
        channelMessageId: 'queued-platform-id', content: 'queued task', contextToken: 'ctx',
        trackId: attributed.context.trackId, trackEventId: attributed.context.attributionEventId })
      expect(readRemoteTrackContextForInbound(db, queued.messageId, { channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1 }))
        .toEqual(attributed.context)
      expect(readRemoteTrackContextForInbound(db, queued.messageId, { channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 2 })).toBeNull()
    } finally { db.close() }
  })
})
