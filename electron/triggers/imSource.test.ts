import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTriggerCondition } from '../../src/shared/domainTypes'
import type { SessionQueries } from '../sessionStorage/public/ports'
import type { ImAcceptedFact, ImAcceptedFactFrontier, ImAcceptedFactScope } from '../sessionStorage/public/model'
import { appendImInboxMessage } from '../database/imInbox'
import { createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database/index'
import { getDbConnection } from '../database/sqliteStore'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { createSessionQueries } from '../sessionStorage/queries'
import { captureImTriggerBaseline, scanImTriggerFacts } from './imSource'
import { evaluateRuntimeTriggerSource } from './sources'

function fixture(channel: ImAcceptedFactScope['channel'], messages: Array<{ senderId: string; body: string }>, limit = 2) {
  const scope: ImAcceptedFactScope = { channel, accountId: 'account', conversationId: 'conversation' }
  const facts: ImAcceptedFact[] = messages.map((message, index) => ({ messageId: `${channel}-${index + 1}`, acceptedSeq: index + 1,
    ...scope, senderId: message.senderId, platformMessageId: `platform-${index + 1}`, timestamp: 100 + index }))
  const frontier: ImAcceptedFactFrontier = { through: facts.length, coverageRevision: 4 }
  const readPage = vi.fn((input: ImAcceptedFactScope & ImAcceptedFactFrontier & { after: number; limit: number }) => {
    const rows = facts.filter((fact) => fact.acceptedSeq > input.after && fact.acceptedSeq <= input.through).slice(0, input.limit)
    const last = rows.at(-1)
    return { items: rows, ...(last && last.acceptedSeq < input.through ? { nextAfter: last.acceptedSeq } : {}) }
  })
  const readBody = vi.fn((input: ImAcceptedFactScope & { messageId: string }) => facts.find((fact) => fact.messageId === input.messageId) ? messages[Number(input.messageId.split('-').at(-1))! - 1]!.body : null)
  const queries = { imAcceptedFacts: { captureFrontier: vi.fn(() => frontier), readPage, readBody } } as unknown as SessionQueries
  return { scope, facts, queries, readPage, readBody, limit, frontier }
}

describe('IM runtime trigger source', () => {
  const fromBeginning = { through: 0, coverageRevision: 4 }
  it.each(['feishu', 'wechat'] as const)('matches exact %s scope, sender, literal body and exposes the accepted message', (channel) => {
    const f = fixture(channel, [{ senderId: 'other', body: 'ready' }, { senderId: 'owner', body: 'prefix [ready].' }, { senderId: 'owner', body: 'PREFIX [READY].' }])
    const condition: RuntimeTriggerCondition = { type: 'im_message', ...f.scope, senderIds: ['owner'], bodyContains: '[ready]' }
    expect(scanImTriggerFacts(f.queries, condition, { pageSize: f.limit, baseline: fromBeginning })).toEqual({ ok: true, frontier: f.frontier, matches: [{
      messageId: `${channel}-2`, acceptedSeq: 2, channel, ...f.scope, senderId: 'owner', platformMessageId: 'platform-2', timestamp: 101,
      body: 'prefix [ready].'
    }] })
    expect(f.readPage).toHaveBeenCalledTimes(2)
  })

  it('scans accepted facts independent of ack status and fails the whole scan when a body or page is unavailable', () => {
    const f = fixture('wechat', [{ senderId: 'owner', body: 'hello' }, { senderId: 'owner', body: 'hello again' }])
    f.readBody.mockImplementationOnce(() => null)
    expect(scanImTriggerFacts(f.queries, { type: 'im_message', ...f.scope }, { pageSize: 2, baseline: fromBeginning })).toMatchObject({ ok: false, code: 'TRIGGER_SOURCE_GAP' })
    expect(f.readBody).toHaveBeenCalledTimes(1)
    f.readBody.mockImplementation((input) => f.facts.find((fact) => fact.messageId === input.messageId) ? 'hello' : null)
    f.readPage.mockImplementationOnce(() => { throw new Error('coverage changed') })
    expect(scanImTriggerFacts(f.queries, { type: 'im_message', ...f.scope }, { pageSize: 2, baseline: fromBeginning })).toMatchObject({ ok: false, code: 'TRIGGER_SOURCE_GAP' })
  })

  it('allows sparse per-conversation accepted sequences below the global frontier', () => {
    const f = fixture('feishu', [{ senderId: 'owner', body: 'first' }, { senderId: 'owner', body: 'second' }])
    f.facts[1] = { ...f.facts[1]!, acceptedSeq: 7 }
    f.queries.imAcceptedFacts.readPage = vi.fn(() => ({ items: f.facts }))
    f.queries.imAcceptedFacts.captureFrontier = vi.fn(() => ({ through: 12, coverageRevision: 4 }))
    expect(scanImTriggerFacts(f.queries, { type: 'im_message', ...f.scope }, { pageSize: 10, baseline: fromBeginning })).toMatchObject({ ok: true, matches: [{ acceptedSeq: 1 }, { acceptedSeq: 7 }] })
  })

  it('starts strictly after the registration baseline and rejects a changed coverage revision', () => {
    const f = fixture('wechat', [{ senderId: 'owner', body: 'before registration' }, { senderId: 'owner', body: 'after registration' }])
    expect(scanImTriggerFacts(f.queries, { type: 'im_message', ...f.scope }, { pageSize: 2, baseline: { through: 1, coverageRevision: 4 } }))
      .toMatchObject({ ok: true, matches: [{ messageId: 'wechat-2' }] })
    expect(scanImTriggerFacts(f.queries, { type: 'im_message', ...f.scope }, { pageSize: 2, baseline: { through: 1, coverageRevision: 3 } }))
      .toMatchObject({ ok: false, case: 'im-baseline-invalid-or-coverage-changed' })
  })

  it.each(['feishu', 'wechat'] as const)('uses the public durable %s acceptance facts across registration order and sent status', (channel) => {
    const db = createMemoryAppDb()
    try {
      const sessionId = createSession(db, { name: `trigger-${channel}` }).id
      const condition: Extract<RuntimeTriggerCondition, { type: 'im_message' }> = { type: 'im_message', channel, accountId: 'account', conversationId: 'chat' }
      const queries = createSessionQueries(db)
      const scope = { channel, accountId: 'account', conversationId: 'chat' }
      const queueScope = buildImQueueScope(channel, sessionId)
      // Event accepted before registration is below the captured baseline.
      appendImInboxMessage(db, { sessionId, channel, queueScope, channelMessageId: 'before', ...scope, senderId: 'sender', content: 'old' })
      const baseline = captureImTriggerBaseline(queries, condition)
      const accepted = appendImInboxMessage(db, { sessionId, channel, queueScope, channelMessageId: 'after', ...scope, senderId: 'sender', content: 'new [match]',
        contextToken: 'reply-context' })
      getDbConnection(db).prepare("UPDATE messages SET status='sent' WHERE id=?").run(accepted.messageId)
      const scan = scanImTriggerFacts(queries, condition, { baseline, pageSize: 10 })
      if (!scan.ok) throw new Error(scan.case)
      expect(scan).toMatchObject({
        ok: true, matches: [{ messageId: accepted.messageId, body: 'new [match]', acceptedSeq: 2, contextToken: 'reply-context' }]
      })
      // If accepted first, registration baseline excludes it in the other order.
      const afterEventBaseline = captureImTriggerBaseline(queries, condition)
      expect(scanImTriggerFacts(queries, condition, { baseline: afterEventBaseline, pageSize: 10 })).toMatchObject({ ok: true, matches: [] })
    } finally { db.close() }
  })

  it('reopens storage and finds a late-page accepted fact after earlier messages were acknowledged', () => {
    const temp = createTempDatabase('trigger-im-recovery-')
    let db = temp.db
    try {
      const sessionId = createSession(db, { name: 'trigger-im-recovery' }).id
      const condition: Extract<RuntimeTriggerCondition, { type: 'im_message' }> = { type: 'im_message', channel: 'feishu', accountId: 'account', conversationId: 'chat', bodyContains: 'target' }
      const queries = createSessionQueries(db)
      const scope = { channel: 'feishu' as const, accountId: 'account', conversationId: 'chat' }
      const queueScope = buildImQueueScope('feishu', sessionId)
      const baseline = captureImTriggerBaseline(queries, condition)
      const ids: string[] = []
      for (let index = 0; index < 105; index += 1) ids.push(appendImInboxMessage(db, { sessionId, channel: 'feishu', queueScope,
        channelMessageId: `page-${index}`, ...scope, senderId: 'sender', content: index === 104 ? 'target last page' : `ordinary-${index}` }).messageId)
      getDbConnection(db).prepare("UPDATE messages SET status='sent' WHERE id IN (" + ids.slice(0, 100).map(() => '?').join(',') + ")").run(...ids.slice(0, 100))
      db.close()
      db = openDatabase(temp.dbPath)
      expect(scanImTriggerFacts(createSessionQueries(db), condition, { baseline, pageSize: 100 })).toMatchObject({ ok: true, matches: [{ messageId: ids[104], acceptedSeq: 105 }] })
    } finally { temp.cleanup(db) }
  })

  it('evaluates an accepted IM fact through the registered trigger baseline', async () => {
    const db = createMemoryAppDb()
    try {
      const sessionId = createSession(db, { name: 'trigger-im-evaluator' }).id
      const condition: Extract<RuntimeTriggerCondition, { type: 'im_message' }> = { type: 'im_message', channel: 'wechat', accountId: 'account', conversationId: 'chat', bodyContains: 'go' }
      const queries = createSessionQueries(db)
      const scope = { channel: 'wechat' as const, accountId: 'account', conversationId: 'chat' }
      const queueScope = buildImQueueScope('wechat', sessionId)
      const baseline = captureImTriggerBaseline(queries, condition)
      const accepted = appendImInboxMessage(db, { sessionId, channel: 'wechat', queueScope, channelMessageId: 'source-1', ...scope,
        senderId: 'sender', content: 'please go now' })
      const trigger = { id: 'im-trigger', ownerSessionId: sessionId, receiverSessionId: sessionId, clientKey: 'im',
        definition: { version: 1 as const, condition, sourceBaseline: baseline }, state: 'waiting' as const, createdAt: 1,
        expiresAt: Date.now() + 60_000, attempts: 0, revision: 1, updatedAt: 1 }

      await expect(evaluateRuntimeTriggerSource(trigger, { now: 500, queries })).resolves.toMatchObject({
        kind: 'candidate', event: { type: 'im_message', acceptedSeq: 1, body: 'please go now', platformMessageId: 'source-1' }
      })
      getDbConnection(db).prepare("UPDATE messages SET status='sent' WHERE id=?").run(accepted.messageId)
      await expect(evaluateRuntimeTriggerSource(trigger, { now: 500, queries })).resolves.toMatchObject({ kind: 'candidate', event: { acceptedSeq: 1 } })
    } finally { db.close() }
  })
})
