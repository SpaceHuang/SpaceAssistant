import type { Message, ToolCallRecord } from './domainTypes'
import type { ClaudeChatMessageWithBlocks } from './api'
import { MAX_CHAT_API_MESSAGES } from './chatApiMessageLimits'
import { toolIdToOpenAiCompatibleApiToolName } from './toolApiFunctionName'

function toolResultContent(tc: ToolCallRecord): string {
  if (!tc.result) return '(无结果)'
  if (tc.result.success) {
    if (tc.result.data === undefined) return '{}'
    return typeof tc.result.data === 'string' ? tc.result.data : JSON.stringify(tc.result.data)
  }
  return tc.result.error ?? '失败'
}

/** API 不接受空字符串 content；无正文时用单空格占位，避免阻断后续请求 */
function ensureApiTextContent(content: string | undefined | null): string {
  const trimmed = (content ?? '').trim()
  return trimmed.length > 0 ? trimmed : ' '
}

/** 将本地消息列表转为带 content blocks 的 API 消息（含历史 tool_use / tool_result） */
export function buildClaudeToolChatMessages(messages: Message[]): ClaudeChatMessageWithBlocks[] {
  const out: ClaudeChatMessageWithBlocks[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (m.role === 'assistant' && m.status === 'streaming') continue
    if (m.role === 'user' && m.status === 'queued') continue
    if (m.role === 'user') {
      out.push({ role: 'user', content: ensureApiTextContent(m.content), id: m.id, timestamp: m.timestamp })
      continue
    }
    if (m.toolCalls?.length) {
      const blocks: unknown[] = []
      if (m.content?.trim()) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls) {
        if (tc.status === 'calling' || tc.status === 'confirming' || tc.status === 'executing') continue
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: toolIdToOpenAiCompatibleApiToolName(tc.toolName),
          input: tc.input
        })
      }
      if (blocks.length === 0) {
        out.push({ role: 'assistant', content: ensureApiTextContent(m.content), id: m.id, timestamp: m.timestamp })
        continue
      }
      out.push({ role: 'assistant', content: blocks, id: m.id, timestamp: m.timestamp })
      const results: unknown[] = []
      for (const tc of m.toolCalls) {
        if (tc.status === 'calling' || tc.status === 'confirming' || tc.status === 'executing') continue
        results.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: toolResultContent(tc)
        })
      }
      if (results.length) out.push({ role: 'user', content: results })
    } else {
      out.push({ role: 'assistant', content: ensureApiTextContent(m.content), id: m.id, timestamp: m.timestamp })
    }
  }
  return out
}

function isToolResultOnlyUserMessage(msg: ClaudeChatMessageWithBlocks): boolean {
  if (msg.role !== 'user' || !Array.isArray(msg.content) || msg.content.length === 0) return false
  return msg.content.every((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result')
}

/** 保留最近 N 条 API 消息；裁剪头部时丢弃孤立的 tool_result，保证以 user 文本消息开头 */
export function trimClaudeToolChatMessages(
  messages: ClaudeChatMessageWithBlocks[],
  maxMessages = MAX_CHAT_API_MESSAGES
): ClaudeChatMessageWithBlocks[] {
  if (messages.length <= maxMessages) return messages

  let trimmed = messages.slice(-maxMessages)
  while (trimmed.length > 0) {
    const first = trimmed[0]
    if (first.role === 'assistant') {
      trimmed = trimmed.slice(1)
      continue
    }
    if (isToolResultOnlyUserMessage(first)) {
      trimmed = trimmed.slice(1)
      continue
    }
    break
  }
  return trimmed
}
