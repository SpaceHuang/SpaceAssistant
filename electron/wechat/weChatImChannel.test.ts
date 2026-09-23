import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { WeChatImChannel, buildWeChatConfirmPrompt, commitWeChatAction } from './weChatImChannel'
import { makeIncomingMessage } from './__mocks__/wechatBotMock'
import type { ConfirmRequest } from '../../src/shared/confirmation/types'
import { openSqliteDatabase, type AppDatabase } from '../database'
import * as decisionCacheWriter from '../confirmation/decisionCacheWriter'
import type { ImPendingConfirm } from '../confirmation/imChannel'

function req(toolName = 'write_file'): ConfirmRequest {
  return {
    facts: {
      toolName,
      actionClass: 'write',
      baseRiskLevel: 'medium',
      signals: [],
      summary: { text: toolName }
    },
    riskLevel: 'medium',
    memoryTiers: [],
    timeoutMs: null
  }
}

describe('WeChatImChannel（原 WeChatConfirmManager 回归）', () => {
  const dbs: AppDatabase[] = []
  const reply = vi.fn(async () => undefined)
  const getReplyBot = () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => dbs.splice(0).forEach((db) => db.close()))

  it('sends IM prompt with Y/N footer on request', async () => {
    const im = new WeChatImChannel({ getReplyBot })
    const inbound = makeIncomingMessage({ raw: { ...makeIncomingMessage().raw, client_id: 'orig' } })
    const promise = im.request(req(), {
      sessionId: 'sess-1',
      toolName: 'write_file',
      messageId: 'orig',
      matchKey: 'wx-user@test',
      context: inbound
    })
    const cid = im.listPending()[0]!.confirmId!
    const ynMsg = {
      messageId: 'yn-1',
      userId: 'wx-user@test',
      text: `Y ${cid}`,
      type: 'text' as const,
      timestamp: new Date().toISOString(),
      contextToken: 'ctx'
    }
    expect(im.tryResolveFromInboundMessage(ynMsg, {
      allowedUserIds: ['wx-user@test']
    })).toBe(true)
    await expect(promise).resolves.toEqual({ kind: 'approved', cause: 'user-approved' })
    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('回复 Y')
    )
  })

  it('heartbeat-style prompt excludes duplicate Y/N when using default builder', () => {
    const prompt = buildWeChatConfirmPrompt({
      id: '1',
      sessionId: 's1',
      toolName: 'write_file',
      messageId: 'm1',
      channel: 'wechat',
      memoryTiers: [],
      createdAt: 1,
      expiresAt: 2,
      confirmId: 'AB12'
    })
    expect(prompt).toContain('【进度】')
    expect(prompt).toContain('AB12')
  })

  it('does not resolve confirm from non-allowlisted sender', async () => {
    const im = new WeChatImChannel()
    const inbound = makeIncomingMessage()
    const promise = im.request(req(), {
      sessionId: 'sess-deny',
      toolName: 'write_file',
      messageId: 'orig',
      matchKey: 'wx-user@test',
      context: inbound
    })
    const ynMsg = {
      messageId: 'yn-attacker',
      userId: 'attacker@test',
      text: 'Y',
      type: 'text' as const,
      timestamp: new Date().toISOString(),
      contextToken: 'ctx'
    }
    expect(
      im.tryResolveFromInboundMessage(ynMsg, {
        allowedUserIds: ['wx-user@test']
      })
    ).toBe(false)
    expect(im.countPending()).toBe(1)
    im.cancelAllPending()
    await expect(promise).resolves.toEqual({ kind: 'rejected', cause: 'cancelled' })
  })

  it('真实微信链路：第一次记忆写入回滚后保留 pending，第二次同码递增 revision 成功', async () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    const tier = { key: { kind: 'shell-command' as const, verb: 'npm test', level: 'exact' as const }, label: '记住 npm test' }
    const write = vi.spyOn(decisionCacheWriter, 'recordUserAnswerFromMemoryTiers').mockImplementationOnce(() => { throw new Error('db-busy') })
    const im = new WeChatImChannel({ db, getReplyBot, getGeneration: () => 0 })
    const inbound = makeIncomingMessage({ raw: { ...makeIncomingMessage().raw, client_id: 'orig-retry' } })
    const p = im.request({ ...req('run_shell'), memoryTiers: [tier] }, {
      sessionId: 's-wechat-retry',
      toolName: 'run_shell',
      toolInput: { command: 'npm test' },
      messageId: 'orig-retry',
      matchKey: 'wx-user@test',
      context: inbound,
      memoryTiers: [tier],
      authorizationGeneration: 0
    })
    const confirmId = im.listPending()[0]!.confirmId!
    const first = { messageId: 'yn-retry-1', userId: 'wx-user@test', text: `记1 ${confirmId}`, type: 'text' as const, timestamp: new Date().toISOString(), contextToken: 'ctx' }
    const second = { ...first, messageId: 'yn-retry-2' }
    expect(im.tryResolveFromInboundMessage(first, { allowedUserIds: ['wx-user@test'] })).toBe(true)
    expect(im.countPending()).toBe(1)
    expect(im.tryResolveFromInboundMessage(second, { allowedUserIds: ['wx-user@test'] })).toBe(true)
    await expect(p).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('撤销后的缺失授权代际 pending 必须 fail closed，不能写入记忆', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    const currentGeneration = { value: 1 }
    const entry = {
      id: 'legacy-wechat-pending',
      sessionId: 's-legacy-wechat',
      toolName: 'run_shell',
      toolInput: { command: 'npm test' },
      messageId: 'm1',
      channel: 'wechat' as const,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      memoryTiers: [{ key: { kind: 'shell-command' as const, verb: 'npm test', level: 'exact' as const }, label: '记住 npm test' }]
    } satisfies ImPendingConfirm
    const write = vi.spyOn(decisionCacheWriter, 'recordUserAnswerFromMemoryTiers')

    expect(commitWeChatAction(db, entry, { kind: 'memory', tier: entry.memoryTiers[0], approved: true }, () => currentGeneration.value)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('过期的微信确认点击不应消耗 commitRevision', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    const entry = {
      id: 'expired-wechat-pending',
      sessionId: 's-expired-wechat',
      toolName: 'run_shell',
      toolInput: { command: 'npm test' },
      messageId: 'm1',
      channel: 'wechat' as const,
      authorizationGeneration: 1,
      commitRevision: 4,
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 1,
      memoryTiers: []
    } satisfies ImPendingConfirm

    expect(commitWeChatAction(db, entry, { kind: 'decision', approved: true }, () => 1)).toBe(false)
    expect(entry.commitRevision).toBe(4)
  })
})
