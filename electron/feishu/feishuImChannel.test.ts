import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeishuImChannel, buildFeishuConfirmPromptText, commitFeishuAction } from './feishuImChannel'
import type { ConfirmRequest } from '../../src/shared/confirmation/types'
import { createAgentRuntime } from '../runtime/agentRuntime'
import { setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { createBuiltinToolRegistry } from '../tools/builtinExecutors'
import { ConfirmIdSpace } from '../remote/confirmId'
import { ChatCancelRegistry } from '../chatCancelRegistry'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { McpConcurrencyGate } from '../mcp/mcpToolExecutor'
import { openSqliteDatabase, type AppDatabase } from '../database'
import * as decisionCacheWriter from '../confirmation/decisionCacheWriter'
import type { LarkCliRunner } from './larkCliRunner'
import type { ImPendingConfirm } from '../confirmation/imChannel'


vi.mock('./feishuReply', () => ({
  replyFeishuText: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./feishuRemoteOutbound', () => ({
  sendFeishuRemoteOutbound: vi.fn().mockResolvedValue(undefined)
}))

const owner = 'ou_owner'
const confirmOpts = { ownerOpenId: owner }
const dbs: AppDatabase[] = []

afterEach(() => dbs.splice(0).forEach((db) => db.close()))

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

function p2p(overrides: {
  messageId?: string
  chatId?: string
  senderOpenId?: string
  content?: string
  chatType?: 'p2p' | 'group'
} = {}) {
  return {
    messageId: overrides.messageId ?? 'm2',
    chatId: overrides.chatId ?? 'c1',
    chatType: overrides.chatType ?? ('p2p' as const),
    senderOpenId: overrides.senderOpenId ?? owner,
    content: overrides.content ?? 'Y',
    createTime: '1',
    mentionsBot: false
  }
}

// P8:显式装配含真 builtin registry 的默认 runtime(兼容转发打到真实注册表)
setDefaultAgentRuntime(
  createAgentRuntime({
    confirmIds: new ConfirmIdSpace(),
    chatCancels: new ChatCancelRegistry(),
    toolRevocations: new ToolRevocationRegistry(),
    mcpGate: new McpConcurrencyGate(),
    builtinRegistry: createBuiltinToolRegistry()
  })
)

describe('FeishuImChannel（原 FeishuConfirmManager 回归）', () => {
  it('does not resolve confirm from group chat', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req(), {
      sessionId: 's-group',
      toolName: 'write_file',
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1'
    })
    expect(
      im.tryResolveFromInboundMessage(p2p({ content: 'Y', chatType: 'group' }), confirmOpts)
    ).toBe(false)
    expect(im.countPending()).toBe(1)
    im.cancelAllPending()
    await expect(p).resolves.toEqual({ kind: 'rejected', cause: 'cancelled' })
  })

  it('does not resolve confirm from non-owner', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req(), {
      sessionId: 's-nonowner',
      toolName: 'write_file',
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1'
    })
    expect(
      im.tryResolveFromInboundMessage(p2p({ content: 'Y', senderOpenId: 'ou_other' }), confirmOpts)
    ).toBe(false)
    expect(im.countPending()).toBe(1)
    im.cancelAllPending()
    await expect(p).resolves.toEqual({ kind: 'rejected', cause: 'cancelled' })
  })

  it('does not resolve confirm when owner unbound', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req(), {
      sessionId: 's-unbound',
      toolName: 'write_file',
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1'
    })
    expect(im.tryResolveFromInboundMessage(p2p({ content: 'Y' }), {})).toBe(false)
    expect(im.countPending()).toBe(1)
    im.cancelAllPending()
    await expect(p).resolves.toEqual({ kind: 'rejected', cause: 'cancelled' })
  })

  it('builds browser navigate confirm text', () => {
    const text = buildFeishuConfirmPromptText({
      id: '1',
      sessionId: 's',
      toolName: 'browser',
      toolInput: { action: 'navigate', url: 'https://example.com/article' },
      messageId: 'm1',
      channel: 'feishu',
      memoryTiers: [],
      createdAt: 0,
      expiresAt: 0
    })
    expect(text).toContain('https://example.com/article')
    expect(text).toContain('回复 Y')
  })

  it('includes progress prefix in confirm text', async () => {
    const { updateRemoteProgressSnapshot, clearRemoteProgressSession } = await import('../remote/remoteProgressStore')
    updateRemoteProgressSnapshot('s-progress', {
      kind: 'tool',
      label: '微信直连失败，改用镜像站点',
      publishable: true
    })
    const text = buildFeishuConfirmPromptText({
      id: '2',
      sessionId: 's-progress',
      toolName: 'browser',
      toolInput: { action: 'navigate', url: 'https://r.jina.ai/example' },
      messageId: 'm1',
      channel: 'feishu',
      memoryTiers: [],
      createdAt: 0,
      expiresAt: 0
    })
    expect(text).toContain('【进度】')
    expect(text).toContain('微信直连失败')
    clearRemoteProgressSession('s-progress')
  })

  it('rejects bare 信任 without approving', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req('run_shell'), {
      sessionId: 's-trust',
      toolName: 'run_shell',
      toolInput: { command: 'npm test' },
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1',
      trustEligible: true
    })
    const cid = im.listPending()[0]!.confirmId!
    expect(
      im.tryResolveFromInboundMessage(p2p({ content: '信任' }), confirmOpts)
    ).toBe(true)
    expect(im.countPending()).toBe(1)
    im.tryResolveFromInboundMessage(p2p({ messageId: 'm3', content: `Y ${cid}` }), confirmOpts)
    await expect(p).resolves.toEqual({ kind: 'approved', cause: 'user-approved' })
  })

  it('approve_and_trust without eligibility does not resolve', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req('run_shell'), {
      sessionId: 's-notrust',
      toolName: 'run_shell',
      toolInput: { command: 'rm -rf /' },
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1',
      trustEligible: false
    })
    const cid = im.listPending()[0]!.confirmId!
    expect(
      im.tryResolveFromInboundMessage(p2p({ content: `Y ${cid} TRUST` }), confirmOpts)
    ).toBe(true)
    expect(im.countPending()).toBe(1)
    im.tryResolveFromInboundMessage(p2p({ messageId: 'm3', content: `N ${cid}` }), confirmOpts)
    await expect(p).resolves.toEqual({ kind: 'rejected', cause: 'user-denied' })
  })

  it('真实飞书链路：第一次记忆写入回滚后保留 pending，第二次同码递增 revision 成功', async () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    const tier = { key: { kind: 'shell-command' as const, verb: 'npm test', level: 'exact' as const }, label: '记住 npm test' }
    const write = vi.spyOn(decisionCacheWriter, 'recordUserAnswerFromMemoryTiers').mockImplementationOnce(() => { throw new Error('db-busy') })
    const im = new FeishuImChannel({ db, runner: {} as LarkCliRunner, getGeneration: () => 0 })
    const p = im.request({ ...req('run_shell'), memoryTiers: [tier] }, {
      sessionId: 's-feishu-retry',
      toolName: 'run_shell',
      toolInput: { command: 'npm test' },
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1',
      memoryTiers: [tier],
      authorizationGeneration: 0
    })
    const confirmId = im.listPending()[0]!.confirmId!
    expect(im.tryResolveFromInboundMessage(p2p({ content: `记1 ${confirmId}` }), confirmOpts)).toBe(true)
    expect(im.countPending()).toBe(1)
    expect(im.tryResolveFromInboundMessage(p2p({ messageId: 'm3', content: `记1 ${confirmId}` }), confirmOpts)).toBe(true)
    await expect(p).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('撤销后的缺失授权代际 pending 必须 fail closed，不能写入记忆', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    const currentGeneration = { value: 1 }
    const entry = {
      id: 'legacy-feishu-pending',
      sessionId: 's-legacy-feishu',
      toolName: 'run_shell',
      toolInput: { command: 'npm test' },
      messageId: 'm1',
      channel: 'feishu' as const,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      memoryTiers: [{ key: { kind: 'shell-command' as const, verb: 'npm test', level: 'exact' as const }, label: '记住 npm test' }]
    } satisfies ImPendingConfirm
    const write = vi.spyOn(decisionCacheWriter, 'recordUserAnswerFromMemoryTiers')
    write.mockClear()

    expect(commitFeishuAction(db, entry, { kind: 'memory', tier: entry.memoryTiers[0], approved: true }, () => currentGeneration.value)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('过期的飞书确认点击不应消耗 commitRevision', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    const entry = {
      id: 'expired-feishu-pending',
      sessionId: 's-expired-feishu',
      toolName: 'run_shell',
      toolInput: { command: 'npm test' },
      messageId: 'm1',
      channel: 'feishu' as const,
      authorizationGeneration: 1,
      commitRevision: 4,
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 1,
      memoryTiers: []
    } satisfies ImPendingConfirm

    expect(commitFeishuAction(db, entry, { kind: 'decision', approved: true }, () => 1)).toBe(false)
    expect(entry.commitRevision).toBe(4)
  })
})
