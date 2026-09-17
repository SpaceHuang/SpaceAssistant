import { z } from 'zod'
import { listSessions, getMessagesPage } from '../../database/operations'
import type { AppDatabase } from '../../database'
import type { CapabilityDescriptor, CapabilityContext } from '../types'
import { isSessionActiveStream } from '../../chatActiveStreams'

/**
 * action.session.* 功能执行系列（需求 §4.2，risk=read 免确认）。
 * 数据源口径与既有链路一致：listSessions（user-visible）与 getMessagesPage；
 * 运行中标志来自 chatActiveStreams 的 sessionId→活跃流登记。
 */

function getDb(ctx: CapabilityContext): AppDatabase | undefined {
  return ctx.appDatabase as AppDatabase | undefined
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
    const db = getDb(ctx)
    if (!db) throw new Error('会话数据不可用：缺少数据库上下文')
    const limit = Math.min(params.limit ?? 20, 50)
    const offset = params.offset ?? 0
    const all = listSessions(db, { view: 'user-visible' })
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
  summary: '查询某个会话是否正在运行（有活跃的流式请求）',
  keywords: ['会话状态', '运行中', '正在运行', 'busy', 'running', 'status'],
  paramsSchema: z.object({ sessionId: z.string().min(1) }).passthrough(),
  paramsDoc: '{ "sessionId": "会话 ID（UUID）" }',
  returnsDoc: '{ running: boolean }',
  risk: 'read',
  handler: async (rawParams) => ({ running: isSessionActiveStream((rawParams as { sessionId: string }).sessionId) })
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
  returnsDoc: '{ messages: [{ sequence, role, timestamp, content, truncated?, originalChars? }], nextSequence, hasMore }',
  risk: 'read',
  notes: ['读取跨会话消息会留审计痕迹'],
  handler: async (rawParams, ctx) => {
    const params = rawParams as SessionReadParams
    const db = getDb(ctx)
    if (!db) throw new Error('会话数据不可用：缺少数据库上下文')
    const limit = Math.min(params.limit ?? 20, 50)
    const cursor = params.cursor ?? 0
    const page = getMessagesPage(db, params.sessionId, cursor, limit)
    // messages 表 sequence 连续递增（MAX+1 分配），页内第 i 条即 cursor+i
    return {
      messages: page.messages.map((m, i) => {
        const sequence = cursor + i
        if (m.content.length > MESSAGE_MAX_CHARS) {
          return {
            sequence,
            role: m.role,
            timestamp: m.timestamp,
            content: `${m.content.slice(0, MESSAGE_MAX_CHARS)}…`,
            truncated: true,
            originalChars: m.content.length
          }
        }
        return {
          sequence,
          role: m.role,
          timestamp: m.timestamp,
          content: m.content
        }
      }),
      nextSequence: page.nextSequence,
      // 满页才可能有余量；非满页即最后一片（空页回填 cursor 时同样为 false）
      hasMore: page.messages.length >= limit
    }
  }
}

export function createSessionCapabilities(): CapabilityDescriptor[] {
  return [listCapability, statusCapability, readCapability]
}
