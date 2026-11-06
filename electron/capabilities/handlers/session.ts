import { z } from 'zod'
import type { CapabilityDescriptor, CapabilityContext } from '../types'
import { getSessionActiveStreamTurnId, isSessionActiveStream } from '../../chatActiveStreams'
import { readExportPageAfterPreparation } from '../../sessionStorage/public/readMessages'

/**
 * action.session.* 功能执行系列（需求 §4.2，risk=read 免确认）。
 * 数据源口径与既有链路一致：listSessions（user-visible）与 getMessagesPage；
 * 运行中标志来自 chatActiveStreams 的 sessionId→活跃流登记。
 */

function getSessionQueries(ctx: CapabilityContext) {
  return ctx.sessionQueries
}

function requireMessageService(ctx: CapabilityContext) {
  if (!ctx.sessionMessages) throw new Error('SESSION_MESSAGE_SERVICE_UNAVAILABLE')
  if (!ctx.sessionId || !ctx.requestId) throw new Error('SESSION_MESSAGE_CALLER_UNAVAILABLE')
  if (ctx.lane !== 'desktop') throw new Error('SESSION_MESSAGE_DESKTOP_ONLY')
  return { service: ctx.sessionMessages, ownerSessionId: ctx.sessionId }
}

const sendMessageCapability: CapabilityDescriptor = {
  id: 'action.session.message.send', family: 'action',
  summary: '向指定的桌面会话发送来信并立即返回接纳回执',
  keywords: ['发送跨会话消息', '给会话发消息', '会话来信', '跨会话发送', 'session message send'],
  paramsSchema: z.object({ targetSessionId: z.string().min(1), requestId: z.string().min(1), content: z.string().min(1).max(100_000) }).strict(),
  paramsDoc: '{ "targetSessionId": "目标会话 ID", "requestId": "调用方作用域内幂等请求 ID", "content": "来信正文" }',
  returnsDoc: '{ accepted: { receipt, duplicate }, wake: "requested" | "retry-pending" }；只表示已接纳，不表示已处理',
  risk: 'act',
  notes: ['只接受已接纳回执，不表示目标会话已处理；目标忙时保持排队', '正文作为不可信跨会话来信，不视为用户批准'],
  handler: async (rawParams, ctx) => {
    const { service, ownerSessionId } = requireMessageService(ctx)
    const params = rawParams as { targetSessionId: string; requestId: string; content: string }
    const requestId = `${ctx.sessionId}:${params.requestId}`
    return service.send({ ownerSessionId, ...params, requestId,
      ...(ctx.sessionMessageAuthorization ? { authorization: ctx.sessionMessageAuthorization } : {}) })
  }
}

const revokeMessageCapability: CapabilityDescriptor = {
  id: 'action.session.message.revoke', family: 'action',
  summary: '撤回仍在排队的自己发送的跨会话来信',
  keywords: ['撤回跨会话消息', '撤回会话来信', '取消发送的来信', 'revoke session message'],
  paramsSchema: z.object({ requestId: z.string().min(1) }).strict(),
  paramsDoc: '{ "requestId": "发送时使用的幂等请求 ID" }',
  returnsDoc: '{ kind: "revoked" | "already-revoked" | "claimed" | "not-found" | "not-revocable", settlement? }',
  risk: 'act',
  notes: ['只可撤回当前会话发送方所有且尚未领取的来信'],
  handler: async (rawParams, ctx) => {
    const { service, ownerSessionId } = requireMessageService(ctx)
    const requestId = (rawParams as { requestId: string }).requestId
    return service.revoke({ ownerSessionId, requestId: `${ctx.sessionId}:${requestId}` })
  }
}

/** 单条消息内容截断阈值（超出截断为摘要 + 提示） */
const MESSAGE_MAX_CHARS = 4_000

interface SessionListParams {
  offset?: number
  limit?: number
}

const listCapability: CapabilityDescriptor = {
  id: 'action.session.list',
  family: 'action',
  summary: '分页枚举用户会话：id、标题、更新时间、运行中标志',
  keywords: ['会话列表', '列出会话', '会话', '列表', 'sessions', 'list'],
  paramsSchema: z
    .object({
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional()
    })
    .passthrough(),
  paramsDoc: '{ "offset": number, "limit": number }（均可选；limit 默认 20，上限 50；offset 为跳过的会话数）',
  returnsDoc: '{ sessions: [{ id, name, updatedAt, running }], total, nextOffset }',
  risk: 'read',
  notes: ['按更新时间倒序；不含内部/隐藏会话'],
  handler: async (rawParams, ctx) => {
    const params = rawParams as SessionListParams
    const queries = getSessionQueries(ctx)
    if (!queries) throw new Error('会话数据不可用：缺少数据库上下文')
    const limit = Math.min(params.limit ?? 20, 50)
    const offset = params.offset ?? 0
    const all = queries.listSessions({ view: 'user-visible' })
    const page = all.slice(offset, offset + limit)
    return {
      sessions: page.map((s) => ({
        id: s.id,
        name: s.name,
        updatedAt: s.updatedAt,
        running: isSessionActiveStream(s.id)
      })),
      total: all.length,
      nextOffset: offset + page.length
    }
  }
}

const statusCapability: CapabilityDescriptor = {
  id: 'action.session.status',
  family: 'action',
  summary: '查询会话运行状态；运行中返回可用于等待回合完成的 turnId',
  keywords: ['会话状态', '运行中', '正在运行', 'busy', 'running', 'status'],
  paramsSchema: z.object({ sessionId: z.string().min(1) }).passthrough(),
  paramsDoc: '{ "sessionId": "会话 ID（UUID）" }',
  returnsDoc: '{ running: boolean, turnId?: string }（运行中提供可用于等待回合完成的 turnId，空闲时省略）',
  risk: 'read',
  handler: async (rawParams) => {
    const sessionId = (rawParams as { sessionId: string }).sessionId
    const turnId = getSessionActiveStreamTurnId(sessionId)
    return turnId ? { running: true, turnId } : { running: false }
  }
}

interface SessionReadParams {
  sessionId: string
  cursor?: number
  limit?: number
}

const readCapability: CapabilityDescriptor = {
  id: 'action.session.read',
  family: 'action',
  summary: '读取某个会话的原始消息（按 sequence 游标分页；单条大消息截断）',
  keywords: ['读取会话', '会话消息', '消息记录', 'read', 'messages', '历史消息'],
  paramsSchema: z
    .object({
      sessionId: z.string().min(1),
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional()
    })
    .passthrough(),
  paramsDoc: '{ "sessionId": "会话 ID", "cursor": number, "limit": number }（cursor 为起始 sequence，默认 0；limit 默认 20，上限 50）',
  returnsDoc: '{ messages: [{ sequence, role, timestamp, status, content, truncated?, originalChars? }], nextSequence, hasMore }',
  risk: 'read',
  notes: ['调用记录经策略决策审计（policy.decision）留存'],
  handler: async (rawParams, ctx) => {
    const params = rawParams as SessionReadParams
    const queries = getSessionQueries(ctx)
    if (!queries) throw new Error('会话数据不可用：缺少数据库上下文')
    // 中5（评审）：与同族 list（view: 'user-visible'）口径对齐——内部会话（审批 Agent /
    // automation internal）与 hidden 会话正文不可被 read 直读，防内部会话内容外泄到模型上下文
    const target = queries.readSession(params.sessionId)
    if (!target || target.ownership === 'internal' || target.visibility === 'hidden') {
      return { error: 'session not found or not user-visible' }
    }
    const limit = Math.min(params.limit ?? 20, 50)
    const cursor = params.cursor ?? 0
    const page = await readExportPageAfterPreparation({ ensureChatBodyV1: ctx.ensureChatBodyV1, queries },
      { sessionId: params.sessionId, fromSequence: cursor, pageSize: limit, signal: ctx.signal })
    return {
      messages: page.rows.map(({ message: m, sequence }) => {
        const source = queries.readAgentSessionMessageSource({ sessionId: params.sessionId, messageId: m.id })
        if (m.content.length > MESSAGE_MAX_CHARS) {
          return {
            sequence,
            role: m.role,
            timestamp: m.timestamp,
            status: m.status,
            content: `${m.content.slice(0, MESSAGE_MAX_CHARS)}…`,
            truncated: true,
            originalChars: m.content.length,
            ...(source ? { source } : {})
          }
        }
        return {
          sequence,
          role: m.role,
          timestamp: m.timestamp,
          status: m.status,
          content: m.content,
          ...(source ? { source } : {})
        }
      }),
      nextSequence: page.nextSequence,
      // 满页才可能有余量；非满页即最后一片（空页回填 cursor 时同样为 false）
      hasMore: page.rows.length >= limit
    }
  }
}

export function createSessionCapabilities(): CapabilityDescriptor[] {
  return [listCapability, statusCapability, readCapability, sendMessageCapability, revokeMessageCapability]
}
