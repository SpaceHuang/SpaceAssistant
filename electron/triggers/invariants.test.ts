import { describe, expect, it } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { claimQueuedTurnAtomicallyInScope, createSession, deleteQueuedUserMessageInScope } from '../database/operations'
import { getDbConnection } from '../database'
import { createSessionCommands } from '../sessionStorage/commands'
import { createRuntimeTriggerService } from './service'
import { evaluateRuntimeTriggerSource } from './sources'
import { createRuntimeTriggerDelivery } from './delivery'
import { createRuntimeTriggerAuthorizationBinding } from './hostAuthorization'

describe('runtime trigger durable invariants under deterministic operation sequences', () => {
  it('replays seed 0x51a7 and preserves single-winner, terminal-state and bounded-capacity invariants after every operation', async () => {
    const seed = 0x51a7
    let randomState = seed
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState }
    const temp = createTempDatabase('runtime-trigger-seeded-invariants-')
    let db = temp.db
    try {
      const owner = createSession(db, { name: 'random-invariant' }).id
      let commands = createSessionCommands(db)
      let now = 10_000
      const makeService = () => createRuntimeTriggerService(commands, { now: () => now, maxActivePerOwner: 32, maxActiveGlobal: 64,
        authorize: () => true, authorizeTarget: () => true })
      let service = makeService()
      const ids: string[] = []
      const exercised = new Set<string>()
      const requiredPrefix = [0, 1, 3, 0, 2, 0, 3, 0, 4, 5] as const
      for (let step = 0; step < 300; step += 1) {
        const operation = requiredPrefix[step] ?? random() % 6
        if (operation === 0 && ids.length < 30) {
          const clientKey = `seed-${seed}-step-${step}`
          const registered = await service.register({ ownerSessionId: owner, params: { clientKey, receiverSessionId: owner,
            expiresAt: now + 20_000, condition: { type: 'time', at: new Date(now + 1_000).toISOString(), taskPrompt: 'wake' } } })
          ids.push(registered.trigger.triggerId)
          exercised.add('register')
        } else if (ids.length) {
          const id = ids[step < requiredPrefix.length ? ids.length - 1 : random() % ids.length]!
          const record = commands.runtimeTriggers.read(id)
          if (operation === 5) {
            db.close()
            db = openDatabase(temp.dbPath)
            commands = createSessionCommands(db)
            service = makeService()
            exercised.add('restart')
          } else if (record?.state === 'waiting' || record?.state === 'matched') {
            if (operation === 1 && record.state === 'waiting') {
              now += 1_000
              if (service.match({ triggerId: id, expectedRevision: record.revision, event: { type: 'time', occurredAt: now } })) exercised.add('match')
            }
            else if (operation === 2) {
              try { service.cancel({ ownerSessionId: owner, params: { triggerId: id, expectedRevision: record.revision } }); exercised.add('cancel') } catch { /* CAS lost is an expected race outcome. */ }
            } else if (operation === 3) {
              service.fail({ triggerId: id, expectedRevision: record.revision,
                code: record.state === 'matched' ? 'TRIGGER_DELIVERY_FAILED' : 'TRIGGER_SOURCE_GAP',
                caseId: record.state === 'matched' ? 'dispatch-fail' : 'seeded-gap' })
              exercised.add(record.state === 'matched' ? 'dispatch-fail' : 'source-gap')
            }
            else if (operation === 4) { now += 25_000; try { service.expire({ triggerId: id, expectedRevision: record.revision }); exercised.add('expire') } catch { /* Expiry is conditional on durable deadline. */ } }
          }
        }
        const rows = ids.map((id) => commands.runtimeTriggers.read(id)).filter((row) => row !== null)
        const matched = rows.filter((row) => row.state === 'matched')
        expect(matched.length, `seed=${seed} step=${step}`).toBeLessThanOrEqual(ids.length)
        expect(new Set(rows.map((row) => row.clientKey)).size, `seed=${seed} step=${step}`).toBe(rows.length)
        expect(commands.runtimeTriggers.countActive({ ownerSessionId: owner, now })).toBeLessThanOrEqual(32)
        for (const row of rows) {
          if (row.state !== 'waiting' && row.state !== 'matched') {
            expect(commands.runtimeTriggers.update(row.id, row.revision, { state: 'matched', event: { type: 'late' }, updatedAt: now }),
              `seed=${seed} step=${step} trigger=${row.id}`).toBeNull()
          }
          if (row.state === 'matched') expect(row.event).toBeDefined()
        }
      }
      expect([...exercised].sort()).toEqual(['cancel', 'dispatch-fail', 'expire', 'match', 'register', 'restart', 'source-gap'])
    } finally { temp.cleanup(db) }
  })

  it('replays one seeded cross-session message and trigger lifecycle against durable facts after every action', async () => {
    const temp = createTempDatabase('cross-session-trigger-state-machine-')
    let db = temp.db
    const seed = 0x08ac71
    let randomState = seed >>> 0
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState }
    const ownerSession = createSession(db, { name: `state-owner-${seed}` })
    const targetSession = createSession(db, { name: `state-target-${seed}` })
    let now = Date.now()
    let commands = createSessionCommands(db)
    const makeService = () => createRuntimeTriggerService(commands, { now: () => now, authorize: () => true, authorizeTarget: () => true })
    let service = makeService()
    const requests: Array<{ requestId: string; messageId: string; triggerId?: string; expected?: string }> = []
    const actions: string[] = []

    const assertInvariants = (action: string) => {
      const conn = getDbConnection(db)
      expect(Number((conn.prepare("SELECT COUNT(*) AS count FROM turns WHERE session_id=? AND state IN ('configuring','prepared','executing','waiting-confirm','running')")
        .get(targetSession.id) as { count: number }).count)).toBeLessThanOrEqual(1)
      for (const request of requests) {
        expect(conn.prepare('SELECT COUNT(*) AS count FROM queue_input_requests WHERE request_id=? AND queue_scope=?')
          .get(request.requestId, 'desktop')).toEqual({ count: 1 })
        if (request.expected === undefined) {
          expect(commands.scopedQueue.readReceipt({ sessionId: targetSession.id, requestId: request.requestId,
            queueScope: { kind: 'desktop' } })?.queuedMessageId).toBe(request.messageId)
        }
        expect(commands.scopedQueue.readReceipt({ sessionId: targetSession.id, requestId: request.requestId,
          queueScope: { kind: 'im', channel: 'wechat', sessionId: 'other-scope' } })).toBeUndefined()
        const settlement = commands.agentSessionMessages.readSettlement({ ownerSessionId: ownerSession.id, requestId: request.requestId })
        if (request.expected === 'claimed') expect(settlement).toMatchObject({ kind: 'turn-terminal', outcome: 'completed' })
        if (request.expected === 'revoked') expect(settlement).toMatchObject({ kind: 'not-executed', reason: 'sender-revoked' })
        if (request.expected === 'deleted') expect(settlement).toMatchObject({ kind: 'not-executed', reason: 'authorized-cancel' })
        if (request.triggerId) {
          const trigger = commands.runtimeTriggers.read(request.triggerId)!
          if (trigger.state !== 'waiting' && trigger.state !== 'matched') {
            expect(commands.runtimeTriggers.update(trigger.id, trigger.revision, { state: 'matched', event: { type: 'forged' }, updatedAt: now }),
              `seed=${seed} action=${action}`).toBeNull()
          }
          if (trigger.event) expect(JSON.stringify(trigger.event), `seed=${seed} action=${action}`).not.toContain('payload-')
          const notificationRequestId = `runtime-trigger:${trigger.id}`
          expect(conn.prepare('SELECT COUNT(*) AS count FROM queue_input_requests WHERE request_id=?').get(notificationRequestId).count)
            .toBeLessThanOrEqual(1)
        }
      }
      expect(commands.runtimeTriggers.countActive({ ownerSessionId: ownerSession.id, now })).toBeLessThanOrEqual(128)
      actions.push(action)
    }

    const send = (requestId: string) => {
      const accepted = commands.agentSessionMessages.accept({ ownerSessionId: ownerSession.id, targetSessionId: targetSession.id,
        requestId, content: `payload-${requestId}`, authorizationBinding: { seed } })
      expect(accepted.duplicate).toBe(false)
      requests.push({ requestId, messageId: accepted.source.messageId })
      assertInvariants(`send:${requestId}`)
    }
    const register = async (requestId: string) => {
      const result = await service.register({ ownerSessionId: ownerSession.id, params: { clientKey: `wait:${requestId}`,
        receiverSessionId: ownerSession.id, expiresAt: now + 60_000, condition: { type: 'agent_session_message', requestId } } })
      const request = requests.find((item) => item.requestId === requestId)!
      request.triggerId = result.trigger.triggerId
      assertInvariants(`register:${requestId}`)
    }
    const matchSettlement = async (requestId: string) => {
      const request = requests.find((item) => item.requestId === requestId)!
      const trigger = commands.runtimeTriggers.read(request.triggerId!)!
      const candidate = await evaluateRuntimeTriggerSource(trigger, { now,
        readAgentSettlement: (ownerId, exactRequestId) => commands.agentSessionMessages.readSettlement({ ownerSessionId: ownerId, requestId: exactRequestId }) })
      expect(candidate.kind).toBe('candidate')
      if (candidate.kind !== 'candidate') return
      expect(JSON.stringify(candidate.event)).not.toContain(`payload-${requestId}`)
      expect(service.match({ triggerId: trigger.id, expectedRevision: trigger.revision, event: candidate.event })).not.toBeNull()
      assertInvariants(`settle:${requestId}`)
    }
    const deliverTwice = (requestId: string) => {
      const triggerId = requests.find((item) => item.requestId === requestId)!.triggerId!
      const scope = { kind: 'desktop' } as const
      const delivery = createRuntimeTriggerDelivery({ read: (id) => commands.runtimeTriggers.read(id),
        update: (id, revision, patch) => commands.runtimeTriggers.update(id, revision, patch),
        expire: (id, revision) => commands.runtimeTriggers.update(id, revision, { state: 'expired', updatedAt: now }),
        authorize: (trigger, queueScope) => createRuntimeTriggerAuthorizationBinding({ trigger, queueScope,
          authority: { policyRevision: `policy-${seed}`, authorizationGeneration: `auth-${seed}`, runtimeGeneration: `runtime-${seed}` }, isAuthorized: () => true }),
        queueScope: () => scope, enqueue: (input) => commands.scopedQueue.enqueue(input),
        readReceipt: (input) => commands.scopedQueue.readReceipt(input) })
      const first = delivery(triggerId)
      const second = delivery(triggerId)
      expect(first.kind).toBe('enqueued')
      expect(second).toEqual(first)
      const trigger = commands.runtimeTriggers.read(triggerId)!
      const notificationRequestId = `runtime-trigger:${triggerId}`
      expect(commands.scopedQueue.readReceipt({ sessionId: ownerSession.id, requestId: notificationRequestId, queueScope: scope })?.queuedMessageId)
        .toBe(trigger.messageId)
      expect(Number(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM queue_input_requests WHERE request_id=?')
        .get(notificationRequestId)!.count)).toBe(1)
      expect(commands.scopedQueue.readReceipt({ sessionId: ownerSession.id, requestId: notificationRequestId,
        queueScope: { kind: 'im', channel: 'feishu', sessionId: 'other-scope' } })).toBeUndefined()
      assertInvariants(`dispatch:${requestId}`)
    }
    const approveAndClaim = (requestId: string) => {
      const snapshot = commands.agentSessionMessages.readApprovalSnapshot({ sessionId: targetSession.id, requestId })!
      const approval = { version: 1 as const, originDigest: snapshot.originDigest, decisionTraceRef: `decision:${requestId}`,
        permitRef: `permit:${requestId}`, ownerSessionId: ownerSession.id, targetSessionId: targetSession.id,
        targetGeneration: targetSession.generation, requestId, messageId: snapshot.source.messageId, queueScope: 'desktop' as const,
        payloadDigest: snapshot.source.payloadSha256, policyRevision: `policy-${seed}`, authorizationGeneration: `auth-${seed}`,
        runtimeGeneration: `runtime-${seed}`, approvedAt: now }
      expect(commands.agentSessionMessages.refreshExecutionApproval({ sessionId: targetSession.id, requestId,
        expectedOriginDigest: snapshot.originDigest, expectedApprovalDigest: snapshot.approvalDigest ?? null, approval })).not.toBeNull()
      claimQueuedTurnAtomicallyInScope(db, { sessionId: targetSession.id, userMessageId: snapshot.source.messageId,
        turnId: `turn:${requestId}`, assistantMessageId: `assistant:${requestId}`, requestId, queueScope: { kind: 'desktop' },
        source: 'agent-session', agentSessionFinalCheck: () => true })
      expect(Number(getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM turns WHERE session_id=? AND state IN ('configuring','prepared','executing','waiting-confirm','running')")
        .get(targetSession.id)!.count)).toBe(1)
      getDbConnection(db).prepare("UPDATE turns SET state='terminal',outcome='completed',updated_at=? WHERE turn_id=?").run(now, `turn:${requestId}`)
      const request = requests.find((item) => item.requestId === requestId)!
      request.expected = 'claimed'
      assertInvariants(`claim+settle:${requestId}`)
    }

    try {
      send(`request-${seed}-claimed`)
      await register(`request-${seed}-claimed`)
      approveAndClaim(`request-${seed}-claimed`)
      await matchSettlement(`request-${seed}-claimed`)
      deliverTwice(`request-${seed}-claimed`)
      const claimedTrigger = commands.runtimeTriggers.read(requests[0]!.triggerId!)!
      service.fail({ triggerId: claimedTrigger.id, expectedRevision: claimedTrigger.revision,
        code: 'TRIGGER_DELIVERY_FAILED', caseId: 'dispatch-fail' })
      assertInvariants('dispatch-fail:claimed')

      send(`request-${seed}-revoked`)
      await register(`request-${seed}-revoked`)
      expect(commands.agentSessionMessages.markNotExecuted({ sessionId: targetSession.id, requestId: `request-${seed}-revoked`, reason: 'sender-revoked' })).toBe(true)
      requests[1]!.expected = 'revoked'
      assertInvariants('revoke')
      await matchSettlement(`request-${seed}-revoked`)
      deliverTwice(`request-${seed}-revoked`)

      send(`request-${seed}-cancelled`)
      await register(`request-${seed}-cancelled`)
      const cancelledTrigger = commands.runtimeTriggers.read(requests[2]!.triggerId!)!
      service.cancel({ ownerSessionId: ownerSession.id, params: { triggerId: cancelledTrigger.id, expectedRevision: cancelledTrigger.revision } })
      expect(deleteQueuedUserMessageInScope(db, requests[2]!.messageId, { kind: 'desktop' })).toMatchObject({ ok: true })
      requests[2]!.expected = 'deleted'
      assertInvariants('cancel')

      send(`request-${seed}-deleted`)
      await register(`request-${seed}-deleted`)
      expect(deleteQueuedUserMessageInScope(db, requests[3]!.messageId, { kind: 'desktop' })).toMatchObject({ ok: true })
      requests[3]!.expected = 'deleted'
      assertInvariants('delete')
      await matchSettlement(`request-${seed}-deleted`)
      deliverTwice(`request-${seed}-deleted`)

      db.close()
      db = openDatabase(temp.dbPath)
      commands = createSessionCommands(db)
      service = makeService()
      assertInvariants('restart')
      expect(actions).toContain('dispatch-fail:claimed')
      expect(actions).toContain('restart')

      for (let step = 0; step < 24; step += 1) {
        const requestId = `request-${seed}-random-${step}`
        send(requestId)
        await register(requestId)
        const choice = random() % 4
        if (choice === 0) {
          const trigger = commands.runtimeTriggers.read(requests.at(-1)!.triggerId!)!
          service.cancel({ ownerSessionId: ownerSession.id, params: { triggerId: trigger.id, expectedRevision: trigger.revision } })
          expect(deleteQueuedUserMessageInScope(db, requests.at(-1)!.messageId, { kind: 'desktop' })).toMatchObject({ ok: true })
          requests.at(-1)!.expected = 'deleted'
          assertInvariants(`random-cancel-delete:${step}`)
        } else {
          if (choice === 1) {
            expect(commands.agentSessionMessages.markNotExecuted({ sessionId: targetSession.id, requestId, reason: 'sender-revoked' })).toBe(true)
            requests.at(-1)!.expected = 'revoked'
            assertInvariants(`random-revoke:${step}`)
          } else if (choice === 2) approveAndClaim(requestId)
          else {
            expect(deleteQueuedUserMessageInScope(db, requests.at(-1)!.messageId, { kind: 'desktop' })).toMatchObject({ ok: true })
            requests.at(-1)!.expected = 'deleted'
            assertInvariants(`random-delete:${step}`)
          }
          await matchSettlement(requestId)
          if (choice === 2 && random() % 2 === 0) {
            const trigger = commands.runtimeTriggers.read(requests.at(-1)!.triggerId!)!
            service.fail({ triggerId: trigger.id, expectedRevision: trigger.revision,
              code: 'TRIGGER_DELIVERY_FAILED', caseId: 'dispatch-fail' })
            assertInvariants(`random-dispatch-fail:${step}`)
          } else deliverTwice(requestId)
        }
        if (random() % 5 === 0) {
          db.close()
          db = openDatabase(temp.dbPath)
          commands = createSessionCommands(db)
          service = makeService()
          assertInvariants(`random-restart:${step}`)
        }
      }
    } finally { temp.cleanup(db) }
  })
})
